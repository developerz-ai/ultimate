// Single responsibility: reading the tree for `scripts/side-effects.ts` — what a package DECLARES,
// what it actually runs at import time, and what its entries anchor. Split out at the 500-line
// ceiling along the seam the script already drew: this file gathers the facts, `side-effects.ts`
// judges them.

import { dirname, join } from 'node:path';
import { maskLiterals, stripComments } from '@ultimat3/cli';
import { isTestPath } from './source-scan';

const KEYWORDS = new Set(
  (
    'export import const let var function class type interface enum declare namespace abstract ' +
    'async default return if for while switch try catch finally else do case break continue ' +
    'throw new with from await yield'
  ).split(' '),
);

/** `foo(`, `foo.bar(`, `foo?.bar(` or `foo = ` — a call or an assignment, at column 0. */
const STATEMENT = /^([A-Za-z_$][\w$]*)(?:\??\.[\w$]+)*\s*(?:\(|=[^=>])/;

/** `import './x'` and `import x from './y'` and `export … from './z'` and `import('./w')`. */
const SPECIFIER =
  /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The 1-based lines on which this module runs something at import time.
 *
 * Read from `stripComments` so a commented-out call is not a finding, and cross-checked against
 * `maskLiterals` so a call quoted inside a template literal is not either — `packages/render/src/
 * hydrate.ts` emits the browser boot script as a string with `if(!e)return…` at column 0, and
 * `packages/cli/src/templates/` emits whole modules that way. Reporting one invents a finding no
 * edit can clear, which is worse than no guard.
 *
 * What it does NOT see, and therefore what needs review rather than a green check: an effect
 * indented inside a top-level block or IIFE, a top-level `await`, a class `static {}` block, and a
 * constructor that registers itself when its `const` is evaluated. Those are silence, not findings
 * — the vacuity guard in `checkSideEffects` is what keeps that silence from becoming the answer.
 */
export function scanTopLevelEffects(source: string): readonly number[] {
  return topLevelEffects(source).map((one) => one.line);
}

/** One top-level statement: the line it starts on, and the name it opens with. */
export interface TopLevelEffect {
  readonly line: number;
  readonly callee: string;
}

export function topLevelEffects(source: string): readonly TopLevelEffect[] {
  const lines = stripComments(source).split('\n');
  const masked = maskLiterals(source).split('\n');
  const found: TopLevelEffect[] = [];
  lines.forEach((line, index) => {
    const match = STATEMENT.exec(line);
    if (match === null || KEYWORDS.has(match[1] as string)) return;
    // Column 0 of the masked line is a space exactly when the text was inside a string literal.
    if ((masked[index] ?? '')[0] === ' ') return;
    found.push({ line: index + 1, callee: match[1] as string });
  });
  return found;
}

/**
 * Modules whose import-time effect is invisible to everything that reaches them, so a bundler that
 * shakes them out breaks something with nothing anywhere to say why. Each must be bare-imported by
 * one of its package's entries; `X_SIDE_EFFECTS_UNANCHORED` is the refusal.
 *
 * **The `sideEffects` array is not what keeps them** — Bun reads any array as `false` and drops the
 * named module regardless (`oven-sh/bun#40650`, reduced to four files with no `@ultimat3/*`,
 * deterministic on 1.4.0, 1.4.1-canary and 1.3.14; esbuild keeps it on the same input). The array
 * still ships, because rollup, webpack and esbuild do honour it and these are packages other people
 * bundle — it is just not the thing enforcing anything here.
 *
 * **A list and not a predicate, for the reason `FLOOR_ABOVE` is one.** Two rules were tried and each
 * was measurably wrong. "Anchor every declared module" put `@ultimat3/core`'s `context.ts` in every
 * browser chunk — **+3,485 B** for `setLoggerContextFields`, whose provider can only answer where a
 * request context exists and which in a browser can never fire at all — and took `like.island.tsx`
 * over its route's declared 50 kB budget. "Anchor every `register*` call" put `@ultimat3/ui`'s
 * `errors.ts` on the barrel, dragging core's whole error registry (~5.6 kB) into every chunk that
 * imports any `@ultimat3/ui` name, which is the exact regression `packages/ui/src/barrel-bytes.test.ts`
 * exists to catch.
 *
 * The discriminator neither predicate could see: a package's own `errors.ts` registers titles for
 * errors whose CONSTRUCTORS live in that same file, so importing the constructor imports the
 * registration — anchored by use, and an anchor would be pure weight. The three below register on
 * behalf of a module that does not import them, which is why nothing anchors them by accident.
 *
 * Measured: anchoring exactly these three costs **0 B** on all four of `examples/dummy`'s islands,
 * and it makes the retention DETERMINISTIC — the `schema-error-codes.ts` flap that
 * `island-bytes.test.ts` and `barrel-bytes.test.ts` both work around went from 12 flaps in 60 pairs
 * (1.4.0) and 28 in 60 (1.3.14) to **0 in 60 on 1.4.0, 1.3.14 and 1.4.1-canary alike**.
 */
export const SIDE_EFFECTS_ANCHORS: Readonly<Record<string, string>> = Object.freeze({
  'packages/core/src/schema-error-codes.ts':
    "registers @ultimat3/schema's error titles, because schema is tier 0 and cannot register its own. What READS them is UltimateError's constructor, which never imports this module — so a shaken build renders every X_VALIDATION_FAILED untitled, in the browser, with nothing to say why.",
  'packages/i18n/src/framework.ts':
    'registers the framework catalog that `t()` falls back to. `t()` is a different module and does not import this one, so without the anchor every framework string renders as its ⟦key⟧ placeholder.',
  'packages/query/src/registry.ts':
    "calls registerPrimitiveRegistrar('query', …), which @ultimat3/core's registrar table reads on behalf of `x` and the manifest. Nothing that registers a query imports this module for a binding.",
});

/**
 * Whether one `sideEffects` entry covers one package-relative path. Entries are globs rooted at the
 * package, so `./src/errors.ts` and `src/errors.ts` are the same entry, and a recursive glob reaches
 * any depth. A `false` field covers nothing, which is what makes it the strongest claim a package
 * can make and the one this rule checks hardest.
 */
export interface EffectModule {
  /** Package-relative POSIX path, e.g. `src/errors.ts`. */
  readonly path: string;
  readonly line: number;
}

export interface PackageFacts {
  /** Repo-relative directory, e.g. `packages/core` — the key the ratchet pins on. */
  readonly dir: string;
  readonly name: string;
  /** The field verbatim: an array, `false`, or `undefined` when the package declares none. */
  readonly declared: readonly string[] | false | undefined;
  /** Every file the package ships, package-relative — what a stale entry is checked against. */
  readonly files: readonly string[];
  /** Import-time effects in modules reachable from `exports`, first line each. */
  readonly effects: readonly EffectModule[];
  /**
   * Package-relative paths a bare `import './x';` in one of this package's ENTRY modules puts in
   * the graph unconditionally — plus the entries themselves, which are already there. This is what
   * `unanchored` is checked against, and it is a different question from `effects`: that one asks
   * whether the module DOES something at import, this one asks whether a bundler can be stopped
   * from deleting it.
   */
  readonly anchored: readonly string[];
}

export const PACKAGE_GLOB = 'packages/*/package.json';

const SKIP = /(?:^|\/)(?:node_modules|dist|\.turbo)\//;

/** The `exports` map's own targets, flattened across conditions. */
const exportTargets = (exports: unknown): readonly string[] => {
  if (typeof exports === 'string') return [exports];
  if (exports === null || typeof exports !== 'object') return [];
  return Object.values(exports as Record<string, unknown>).flatMap(exportTargets);
};

/**
 * Under the package, and not merely reachable from it. `join` collapses `..`, so a relative
 * specifier CAN leave: `../../core/src/errors` resolves to a real file, and `path` below is then
 * `file.slice(absolute.length + 1)` — ANOTHER package's absolute path sliced at this one's length.
 * Measured on a scratch tree: `packages/beta/src/effect.ts` reached from `packages/alpha` reported
 * `packages/alpha/rc/effect.ts`, a file in neither, and the two findings chase each other —
 * `X_SIDE_EFFECTS_UNDECLARED` demands the entry, `X_SIDE_EFFECTS_ENTRY_STALE` refuses it because
 * nothing on disk matches, and no edit clears either. The exact shape lines 92-93 argue against.
 */
const inside = (absolute: string, file: string): boolean => file.startsWith(`${absolute}/`);

const CANDIDATES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

async function resolveRelative(from: string, spec: string): Promise<string | null> {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(from), spec);
  for (const suffix of CANDIDATES) {
    const candidate = `${base}${suffix}`;
    if (!/\.tsx?$/.test(candidate)) continue;
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

/**
 * Every module reachable from the package's `exports`, and the import-time effects in each. One
 * walk for both, because they are one question: a build script under `src/` that nothing exports
 * (`if (import.meta.main)`, `bin.ts`) must NOT be demanded in the field — noise in `sideEffects` is
 * how the field stops being read, and this is where the noise is filtered out.
 *
 * Relative specifiers only, and only INSIDE the package — a cross-package import stops at the
 * boundary, which is the other package's `sideEffects` to answer for. `inside` is what makes that
 * sentence true rather than merely written.
 */
export async function reachableEffects(
  root: string,
  dir: string,
  exports: unknown,
): Promise<readonly EffectModule[]> {
  const absolute = join(root, dir);
  const queue = exportTargets(exports)
    .filter((target) => /\.tsx?$/.test(target))
    .map((target) => join(absolute, target))
    .filter((file) => inside(absolute, file));
  const seen = new Set<string>();
  const effects: EffectModule[] = [];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !(await Bun.file(file).exists())) continue;
    seen.add(file);
    const source = await Bun.file(file).text();
    const statements = topLevelEffects(source);
    const first = statements[0];
    if (first !== undefined && !isTestPath(file)) {
      effects.push({ path: file.slice(absolute.length + 1), line: first.line });
    }
    for (const match of stripComments(source).matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (spec === undefined) continue;
      const resolved = await resolveRelative(file, spec);
      if (resolved !== null && inside(absolute, resolved)) queue.push(resolved);
    }
  }
  return effects.sort((a, b) => a.path.localeCompare(b.path));
}

/** A bare `import './x';` — no clause, so the module is imported for its effect and nothing else. */
const BARE_IMPORT = /^\s*import\s+['"](\.[^'"]*)['"]\s*;?\s*$/gm;

/**
 * What a bundler cannot delete: every ENTRY of the package, plus every module an entry imports
 * bare. Entries are already unconditional — a consumer asked for them by name — and a bare import
 * is a statement, not a binding, so no shaker has a reason to drop it.
 *
 * Entries only, deliberately, and not "any module that bare-imports it": a bare import sitting in
 * a module the shaker itself removed anchors nothing, and a rule that accepted one would pass on
 * exactly the graphs this exists to catch. `@ultimat3/render`'s `src/server.ts` needs no import
 * anywhere for the same reason it must not have one in the browser barrel — it IS an entry,
 * `@ultimat3/render/server`, and axiom 6 says the static path may not pay for it.
 */
export async function anchoredModules(
  root: string,
  dir: string,
  exports: unknown,
): Promise<readonly string[]> {
  const absolute = join(root, dir);
  const entries = exportTargets(exports)
    .filter((target) => /\.tsx?$/.test(target))
    .map((target) => join(absolute, target))
    .filter((file) => inside(absolute, file));
  const anchored = new Set<string>();
  for (const entry of entries) {
    if (!(await Bun.file(entry).exists())) continue;
    anchored.add(entry.slice(absolute.length + 1));
    const source = stripComments(await Bun.file(entry).text());
    for (const match of source.matchAll(BARE_IMPORT)) {
      const spec = match[1];
      if (spec === undefined) continue;
      const resolved = await resolveRelative(entry, spec);
      if (resolved !== null && inside(absolute, resolved)) {
        anchored.add(resolved.slice(absolute.length + 1));
      }
    }
  }
  return [...anchored].sort();
}

const declaredField = (value: unknown): readonly string[] | false | undefined => {
  if (value === false) return false;
  if (Array.isArray(value)) return value.filter((one): one is string => typeof one === 'string');
  return undefined;
};

export async function readPackageFacts(root: string): Promise<readonly PackageFacts[]> {
  const facts: PackageFacts[] = [];
  for (const manifest of new Bun.Glob(PACKAGE_GLOB).scanSync({ cwd: root })) {
    const dir = dirname(manifest);
    const parsed: unknown = await Bun.file(join(root, manifest)).json();
    const pkg = parsed as { name?: string; sideEffects?: unknown; exports?: unknown };
    const files = [...new Bun.Glob('**/*').scanSync({ cwd: join(root, dir), onlyFiles: true })]
      .map((path) => path.split('\\').join('/'))
      .filter((path) => !SKIP.test(`/${path}`));
    facts.push({
      dir,
      name: pkg.name ?? dir,
      declared: declaredField(pkg.sideEffects),
      files,
      effects: await reachableEffects(root, dir, pkg.exports),
      anchored: await anchoredModules(root, dir, pkg.exports),
    });
  }
  return facts.sort((a, b) => a.dir.localeCompare(b.dir));
}
