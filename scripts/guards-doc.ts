#!/usr/bin/env bun
// Generate `docs/architecture/guards.md` from the guards' own headers — command (in the form that
// reports, never one that writes), what it refuses, the codes it emits — and refuse a committed
// page that has drifted from them.
//
// Root `CLAUDE.md` carried ~30 hand-written guard rows, each restating a header that already said
// the same thing, and each free to go stale on its own (the `catch-render` row named the wrong gate
// step for a release). A page generated from the headers cannot disagree with them.
//
//   bun run scripts/guards-doc.ts [--check | --write] [--json]

// why: host-separator paths to each script; Bun ships no path API.
import { join } from 'node:path';
import { stripComments } from '../packages/core/src/source-mask';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'guards-doc';
export const GUARDS_PAGE = 'docs/architecture/guards.md';
const FIX = 'bun run scripts/guards-doc.ts --write';

export interface Guard {
  readonly command: string;
  readonly file: string;
  readonly refuses: string;
  readonly codes: readonly string[];
}

/** The first sentence of the header's first paragraph, joined across its `//` lines. */
export function headerSentence(source: string): string | undefined {
  const lines = source.split('\n');
  let at = 0;
  while (at < lines.length && (lines[at]?.startsWith('#!') || lines[at]?.trim() === '')) at += 1;
  const paragraph: string[] = [];
  for (; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (!line.startsWith('//')) break;
    const text = line.replace(/^\/\/\s?/, '').trim();
    if (text === '') break;
    paragraph.push(text);
  }
  if (paragraph.length === 0) return undefined;
  const joined = paragraph.join(' ');
  const end = joined.search(/[.!?](\s|$)/);
  return end === -1 ? joined : joined.slice(0, end + 1);
}

/** Every quoted `X_*` literal outside a comment: the codes the file can put on a finding. */
const codesIn = (source: string): readonly string[] =>
  [
    ...new Set(
      [...stripComments(source).matchAll(/['"`](X_[A-Z0-9_]+)['"`]/g)].map((m) => m[1] ?? ''),
    ),
  ]
    .filter((code) => code !== '')
    .sort();

/**
 * The `scripts/lib/*` modules a guard imports, by path — one level, never their own imports. Read
 * off the comment-stripped source, so an import written in prose is no import. A guard's findings
 * are raised wherever its rule lives, and `changelog-check`'s pairing codes live in
 * `lib/changelog-pairing.ts`: a row reading only the script's own text listed none of them.
 */
export const libImportsOf = (source: string): readonly string[] => [
  ...new Set(
    // `from './lib/x'` and the side-effect `import './lib/x'`: both load the module, and either
    // form may raise its codes. A dynamic `import('./lib/x')` is left out: it is a value, not a load.
    [
      ...stripComments(source).matchAll(
        /(?:\bfrom|\bimport)\s*['"]\.\/lib\/([a-z0-9-]+)(?:\.ts)?['"]/g,
      ),
    ].map((m) => `scripts/lib/${m[1] ?? ''}.ts`),
  ),
];

/**
 * Shared infrastructure every guard leans on, contributing NO codes to a row: flag parsing
 * (`X_CLI_BAD_FLAG`), the subprocess boundary (`X_CLI_UNEXPECTED`), the corpus floor
 * (`X_CORPUS_UNSCANNED`), the ratchet, the workspace and tier tables. Listed by name — measured
 * 2026-10-03, `args` and `run` are imported by 63 and 59 of 74 guards — because a row that repeats
 * them on every line says nothing about the guard it is on.
 */
export const SHARED_LIBS: ReadonlySet<string> = new Set(
  [
    'app-select',
    'args',
    'corpus',
    'doc-citations',
    'log',
    'ratchet',
    'ratchet-sites',
    'run',
    'tiers',
    'verify-args',
    'workspaces',
  ].map((name) => `scripts/lib/${name}.ts`),
);

/**
 * A pin table (`scripts/lib/*-pins.ts`, `pin-raises`' own glob) is data: its `reason` sentences
 * NAME codes (`X_VERIFY_STEP_TIMEOUT`) and raise none.
 */
const contributesCodes = (lib: string): boolean =>
  !SHARED_LIBS.has(lib) && !lib.endsWith('-pins.ts');

/** The guard's own codes and those of each rule-specific lib module it imports, one level down. */
async function guardCodes(root: string, source: string): Promise<readonly string[]> {
  const codes = new Set(codesIn(source));
  for (const lib of libImportsOf(source).filter(contributesCodes)) {
    const file = Bun.file(join(root, lib));
    if (!(await file.exists())) continue;
    for (const code of codesIn(await file.text())) codes.add(code);
  }
  return [...codes].sort();
}

/** `bun run <name>` where `package.json` names the script, else the path itself. */
async function commandsByFile(root: string): Promise<ReadonlyMap<string, string>> {
  const manifest: unknown = await Bun.file(join(root, 'package.json')).json();
  const scripts =
    (manifest as { readonly scripts?: Readonly<Record<string, string>> }).scripts ?? {};
  const byFile = new Map<string, string>();
  for (const [name, line] of Object.entries(scripts)) {
    const file = /(?:^|\s)(scripts\/[a-z0-9-]+\.ts)(?:\s|$)/.exec(line)?.[1];
    // The first name wins, so `lockfile` and `lockfile:fix` document the reporting form.
    if (file !== undefined && !byFile.has(file)) byFile.set(file, `bun run ${name}`);
  }
  return byFile;
}

/**
 * The form of `command` that REPORTS. A header whose usage line offers a bare optional `[--check]`
 * is a script that WRITES without it (`schema-dumps` regenerates every tracked app's dump), and a
 * page of guards that lists the writing form hands its reader a command that edits the tree. The
 * usage line is the header's own `//   bun run …`; `[--check | --write]` and a required `--check`
 * already report by default and are left as they are.
 */
export function reportingForm(command: string, source: string): string {
  const usage = /^\/\/\s+bun run \S+(.*)$/m.exec(source)?.[1] ?? '';
  return usage.includes('[--check]') ? `${command} --check` : command;
}

/**
 * A guard is a top-level runnable script (`import.meta.main`) that emits at least one code. Tests,
 * `lib/` helpers and pure libraries are excluded by that definition, never by a list.
 */
export async function collectGuards(root: string): Promise<readonly Guard[]> {
  const commands = await commandsByFile(root);
  const guards: Guard[] = [];
  for await (const name of new Bun.Glob('scripts/*.ts').scan({ cwd: root })) {
    const file = name.split('\\').join('/');
    if (file.endsWith('.test.ts') || file.includes('.fixtures.')) continue;
    const source = await Bun.file(join(root, file)).text();
    if (!source.includes('import.meta.main')) continue;
    // A guard is still defined by ITS OWN codes; the lib modules only complete its row.
    if (codesIn(source).length === 0) continue;
    const codes = await guardCodes(root, source);
    guards.push({
      command: reportingForm(commands.get(file) ?? `bun run ${file}`, source),
      file,
      refuses: headerSentence(source) ?? '(no header comment)',
      codes,
    });
  }
  return guards.sort((a, b) => a.file.localeCompare(b.file));
}

const cell = (text: string): string => text.replaceAll('|', '\\|');

// A named helper and not a template nested inside another's `${}`: `@ultimat3/core`'s
// `maskLiterals` does not track that nesting, so every `code:` below the nested form went unseen by
// the code scanner and the gate reported this file's own codes as registered by nothing.
const codeCell = (code: string): string => `\`${code}\``;

export function renderGuardsPage(guards: readonly Guard[]): string {
  const rows = guards.map(
    (guard) =>
      `| \`${guard.command}\` | ${cell(guard.refuses)} | ${guard.codes.map(codeCell).join(' ')} |`,
  );
  return [
    '# Guards',
    '',
    'GENERATED by `bun run scripts/guards-doc.ts --write` from each script’s own header — never',
    'hand-edited; `--check` refuses drift (`X_GUARDS_DOC_DRIFT`). A guard is a runnable',
    '`scripts/*.ts` that emits at least one code. Which gate step runs each one is',
    '`scripts/verify.ts` and `VERIFY_STEP_NAMES`; the codes are in',
    '[`wiki/Error-Codes.md`](../../wiki/Error-Codes.md).',
    '',
    '| Command | What its header says it refuses | Codes |',
    '|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

export async function guardsDocFindings(root: string): Promise<readonly Finding[]> {
  const guards = await collectGuards(root);
  if (guards.length === 0) {
    return [
      {
        code: 'X_GUARDS_DOC_UNSCANNED',
        cause: 'no runnable scripts/*.ts emitting a code was found, so the page would list nothing',
        fix: 'bun run scripts/guards-doc.ts --check --json   # run from the repository root',
        at: 'scripts/',
      },
    ];
  }
  const page = Bun.file(join(root, GUARDS_PAGE));
  const committed = (await page.exists()) ? await page.text() : '';
  if (committed === renderGuardsPage(guards)) return [];
  return [
    {
      code: 'X_GUARDS_DOC_DRIFT',
      cause: `${GUARDS_PAGE} does not match the headers of the ${guards.length} guards it is generated from`,
      fix: FIX,
      at: GUARDS_PAGE,
    },
  ];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    const guards = await collectGuards(root);
    await Bun.write(join(root, GUARDS_PAGE), renderGuardsPage(guards));
    report(
      { ok: true, script: SCRIPT, summary: `${GUARDS_PAGE} written — ${guards.length} guards` },
      args.json,
    );
  }
  const findings = await guardsDocFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0 ? `${GUARDS_PAGE} matches the guard headers` : 'guards page drift',
      findings,
    },
    args.json,
  );
}
