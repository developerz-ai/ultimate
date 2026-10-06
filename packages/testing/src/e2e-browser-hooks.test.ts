// Every hook that opens or closes a browser has a deadline derived from what it does: an open
// starts at `E2E_BROWSER_OPEN_MS`, a close at `E2E_BROWSER_CLOSE_MS`, an app boot adds
// `E2E_APP_START_MS` and an app stop `E2E_APP_STOP_MS`. A literal there was the shape of four CI
// flakes — Bun killed the hook before the relaunch — and Bun's 5 s default around a close was a
// leaked Chrome profile per run cut short. Read from the suites' source, through their helpers.

import { describe, expect, test } from 'bun:test';
// why: the repository root, from this file's own location; Bun has no path-join primitive.
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');

/** Where a browser-backed suite lives: a package's `e2e/`, and an app's. */
const SUITES = [
  'packages/*/e2e/**/*.ts',
  'examples/*/apps/*/e2e/**/*.ts',
  'dummy/*/apps/*/e2e/**/*.ts',
];

/** What starts a browser — and, transitively, every exported helper whose body calls one. */
const OPENERS = [
  'openE2eBrowser',
  'openE2eBrowserIfAvailable',
  'launchChrome',
  'launchFoundChrome',
  'cdpShotDriver',
  'leaseE2eBrowser',
];
/** What boots an e2e app, likewise. */
const STARTERS = ['startE2eApp'];

const OPEN = 'E2E_BROWSER_OPEN_MS';
const CLOSE = 'E2E_BROWSER_CLOSE_MS';
const APP_START = 'E2E_APP_START_MS';
const APP_STOP = 'E2E_APP_STOP_MS';

const callsAny = (names: ReadonlySet<string>, source: string): boolean =>
  [...names].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));

/**
 * The top-level arguments of the call whose `(` is at `open`, and where the call ends. Strings,
 * templates and comments are skipped — the hooks hold template literals with brackets in them —
 * and a template's `${…}` is code again.
 */
function callArguments(
  source: string,
  open: number,
): { readonly args: readonly string[]; readonly end: number } {
  const stack: string[] = [];
  const args: string[] = [];
  let from = open + 1;
  const closer: Record<string, string> = { '(': ')', '[': ']', '{': '}', '${': '}' };
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i] ?? '';
    const mode = stack.at(-1);
    if (mode === '`') {
      if (ch === '\\') i += 1;
      else if (ch === '`') stack.pop();
      else if (ch === '$' && source[i + 1] === '{') {
        stack.push('${');
        i += 1;
      }
      continue;
    }
    if (mode === "'" || mode === '"') {
      if (ch === '\\') i += 1;
      else if (ch === mode) stack.pop();
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
      if (i <= 0) break;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (mode !== undefined && ch === closer[mode]) {
      stack.pop();
      if (stack.length === 0) {
        args.push(source.slice(from, i).trim());
        return { args: args.filter((arg) => arg !== ''), end: i + 1 };
      }
    } else if (ch === ',' && stack.length === 1) {
      args.push(source.slice(from, i).trim());
      from = i + 1;
    }
  }
  return { args, end: -1 };
}

/** Every `export function NAME` / `export async function NAME`, with its body. */
function exportedFunctions(source: string): readonly { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    const params = callArguments(source, match.index + match[0].length - 1);
    const brace = source.indexOf('{', params.end);
    if (params.end < 0 || brace < 0) continue;
    const body = callArguments(source, brace);
    found.push({ name: match[1] ?? '', body: source.slice(brace, body.end) });
  }
  return found;
}

/** `names`, grown by every exported helper whose body calls one of them, until nothing is added. */
function closure(seed: readonly string[], sources: ReadonlyMap<string, string>): Set<string> {
  const names = new Set(seed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const source of sources.values()) {
      for (const helper of exportedFunctions(source)) {
        if (names.has(helper.name) || !callsAny(names, helper.body)) continue;
        names.add(helper.name);
        grew = true;
      }
    }
  }
  return names;
}

/** `const NAME = …;` declared in `source`, `export const NAME = …;` in any scanned file. */
function declarations(
  sources: ReadonlyMap<string, string>,
): (file: string, name: string) => string | undefined {
  const exported = new Map<string, string>();
  for (const source of sources.values()) {
    for (const match of source.matchAll(/export const ([A-Z_][A-Z0-9_]*)\s*=\s*([^;]+);/g)) {
      exported.set(match[1] ?? '', (match[2] ?? '').trim());
    }
  }
  return (file, name) =>
    new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(sources.get(file) ?? '')?.[1]?.trim() ??
    exported.get(name);
}

type Lookup = (name: string) => string | undefined;

/**
 * The deadline as its top-level SUM, each named term expanded to its declaration — or `undefined`
 * when anything is subtracted, which no "at least" can be read through.
 */
function terms(expression: string, lookup: Lookup, depth = 0): readonly string[] | undefined {
  if (/(^|[^e])-/.test(expression.replace(/\s+/g, ''))) return undefined;
  const out: string[] = [];
  for (const raw of expression.split('+')) {
    const term = raw
      .trim()
      .replace(/^\((.*)\)$/s, '$1')
      .trim();
    const declared = /^[A-Z_][A-Z0-9_]*$/.test(term) && depth < 8 ? lookup(term) : undefined;
    if (declared === undefined) {
      out.push(term);
      continue;
    }
    const inner = terms(declared, lookup, depth + 1);
    if (inner === undefined) return undefined;
    out.push(...inner);
  }
  return out;
}

/** `NAME` or `<n> * NAME` among the terms: the sum is at least that budget. */
const holds = (sum: readonly string[] | undefined, budget: string): boolean =>
  sum?.some((term) => new RegExp(`^(?:${budget}|[1-9]\\d*\\s*\\*\\s*${budget})$`).test(term)) ===
  true;

interface BrowserHook {
  readonly file: string;
  readonly line: number;
  readonly deadline: string;
  /** What the deadline must hold, by name, for what this hook does. */
  readonly needs: readonly (readonly string[])[];
  readonly sum: readonly string[] | undefined;
}

interface Scan {
  readonly sources: ReadonlyMap<string, string>;
  readonly openers: ReadonlySet<string>;
  readonly starters: ReadonlySet<string>;
  readonly lookup: (file: string, name: string) => string | undefined;
}

const scanOf = (sources: ReadonlyMap<string, string>): Scan => ({
  sources,
  openers: closure(OPENERS, sources),
  starters: closure(STARTERS, sources),
  lookup: declarations(sources),
});

/**
 * Every ASYNC `beforeAll`/`afterAll` of a file that opens a browser, with what its deadline must
 * hold: an open, or — for an `afterAll` in a file that holds no lease, so nothing it awaits is an
 * open still in flight — a close; and the app's start or stop when the hook does either.
 */
function browserHooks(file: string, scan: Scan): readonly BrowserHook[] {
  const source = scan.sources.get(file) ?? '';
  if (!callsAny(scan.openers, source)) return [];
  const leases = /\bleaseE2eBrowser\s*\(/.test(source);
  const startsApp = callsAny(scan.starters, source);
  const hooks: BrowserHook[] = [];
  for (const found of source.matchAll(/\b(beforeAll|afterAll)\(/g)) {
    const { args } = callArguments(source, found.index + found[0].length - 1);
    const body = args[0] ?? '';
    // A synchronous hook stops a server; nothing in it can wait on a browser.
    if (!/^async\b/.test(body)) continue;
    const after = found[1] === 'afterAll';
    const needs: string[][] = [after && !leases ? [OPEN, CLOSE] : [OPEN]];
    if (callsAny(scan.starters, body)) needs.push([APP_START]);
    if (after && startsApp && /\.stop\(\)/.test(body)) needs.push([APP_STOP]);
    // A comment beside the deadline says why it is what it is; it is not part of the sum.
    const deadline = (args[1] ?? '').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
    hooks.push({
      file,
      line: source.slice(0, found.index).split('\n').length,
      deadline,
      needs,
      sum: deadline === '' ? [] : terms(deadline, (name) => scan.lookup(file, name)),
    });
  }
  return hooks;
}

const short = (hooks: readonly BrowserHook[]): string[] =>
  hooks.flatMap((hook) => {
    const missing = hook.needs.filter((any) => !any.some((budget) => holds(hook.sum, budget)));
    if (missing.length === 0) return [];
    const wants = missing.map((any) => any.join(' or ')).join(', ');
    return [
      `${hook.file}:${String(hook.line)} — ${hook.deadline || "Bun's 5 s default"} (needs ${wants})`,
    ];
  });

describe('browser hook deadlines', () => {
  test('every hook that opens or closes a browser is given the designed length of what it does', async () => {
    const sources = new Map<string, string>();
    for (const pattern of SUITES) {
      for await (const file of new Bun.Glob(pattern).scan({ cwd: ROOT })) {
        if (file.includes('/node_modules/')) continue;
        sources.set(file, await Bun.file(join(ROOT, file)).text());
      }
    }
    const scan = scanOf(sources);
    const hooks = [...sources.keys()].flatMap((file) => browserHooks(file, scan));

    // Non-vacuity: the scan reaches the suites the flakes came from, and — through the helper
    // that opens their browser — the app's acceptance suites, which name no opener themselves.
    const files = hooks.map((hook) => hook.file);
    expect(files).toContain('packages/cli/e2e/client-navigation-fixture.ts');
    expect(files).toContain('examples/dummy/apps/web/e2e/sign-out.e2e.test.ts');
    expect(short(hooks)).toEqual([]);
  });

  /** One file, scanned alone, plus whatever helper files ride beside it. */
  const scanned = (file: string, source: string, helpers: Record<string, string> = {}) =>
    short(browserHooks(file, scanOf(new Map([[file, source], ...Object.entries(helpers)]))));

  const suite = (deadline: string, hook = 'beforeAll', opens = 'openE2eBrowser'): string =>
    `const browser = await ${opens}();\n${hook}(async () => {\n  await go(\`\${a}(\`);\n}${deadline});`;

  test('a literal, a missing deadline and a smaller expression are each caught', () => {
    expect(scanned('a.ts', suite(', 60_000'))).toEqual([`a.ts:2 — 60_000 (needs ${OPEN})`]);
    expect(scanned('b.ts', suite(''))).toEqual([`b.ts:2 — Bun's 5 s default (needs ${OPEN})`]);
    expect(scanned('c.ts', suite(`, ${OPEN} - 1`))).toHaveLength(1);
    expect(scanned('d.ts', suite(`, ${OPEN} + TAB_MS`))).toEqual([]);
    expect(scanned('e.ts', suite(`, 2 * ${OPEN}`))).toEqual([]);
    expect(scanned('f.ts', `const HOOK_MS = ${OPEN} + 1;\n${suite(', HOOK_MS')}`)).toEqual([]);
    expect(scanned('h.ts', suite(`,\n  // why it is this long\n  ${OPEN} + 1`))).toEqual([]);
    // A file that opens no browser has no browser hooks.
    expect(scanned('g.ts', 'beforeAll(async () => {}, 1);')).toEqual([]);
  });

  test('a close is held to the close budget, and to the open one where it may await an open', () => {
    expect(scanned('a.ts', suite(`, ${CLOSE}`, 'afterAll'))).toEqual([]);
    expect(scanned('b.ts', suite('', 'afterAll'))).toHaveLength(1);
    // `beforeAll` opens: a close budget is not enough there.
    expect(scanned('c.ts', suite(`, ${CLOSE}`))).toHaveLength(1);
    // A lease's release may await the open still in flight.
    expect(scanned('d.ts', suite(`, ${CLOSE}`, 'afterAll', 'leaseE2eBrowser'))).toHaveLength(1);
  });

  test('a helper that opens a browser makes its callers browser suites, and its constants resolve', () => {
    const helper = {
      'fixtures/app.ts': [
        `export const SETUP_MS = ${OPEN} + ${APP_START};`,
        'export async function ownBrowser(): Promise<B> {\n  return openE2eBrowser();\n}',
        'export async function boot(): Promise<A> {\n  return startE2eApp({ root });\n}',
      ].join('\n'),
    };
    const uses = (deadline: string) =>
      `beforeAll(async () => {\n  app = await boot();\n  b = await ownBrowser();\n}${deadline});`;

    expect(scanned('a.ts', uses(', 240_000'), helper)).toHaveLength(1);
    expect(scanned('b.ts', uses(', SETUP_MS + DEFAULT_CDP_TIMEOUT_MS'), helper)).toEqual([]);
    // Opens a browser AND boots an app: the open alone is short by the boot.
    expect(scanned('c.ts', uses(`, ${OPEN}`), helper)).toEqual([
      `c.ts:1 — ${OPEN} (needs ${APP_START})`,
    ]);
    const stops = (deadline: string) =>
      `const x = () => boot();\nafterAll(async () => {\n  await b.close();\n  await app.stop();\n}${deadline});\n${uses(', SETUP_MS')}`;
    expect(scanned('d.ts', stops(`, ${CLOSE}`), helper)).toEqual([
      `d.ts:2 — ${CLOSE} (needs ${APP_STOP})`,
    ]);
    expect(scanned('e.ts', stops(`, ${CLOSE} + ${APP_STOP}`), helper)).toEqual([]);
  });
});
