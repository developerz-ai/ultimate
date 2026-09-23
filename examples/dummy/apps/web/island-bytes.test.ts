// Two builds of an unchanged tree publish the same island under the same URL — for every island
// whose graph the Bun 1.4.0 tree-shaker answers the same way twice.
//
// `IslandChunk.url` is `contentHash(code)`, so a build that is not byte-reproducible is an
// immutable URL that is not immutable: a CDN, a precache manifest and a deploy that diffs
// artefacts all see a change that is not one, and the `budgets` gate step measures a moving
// number (issue #273). Nothing anywhere asserted this.
//
// It pins the half that is OURS — the plugin chain `buildIslands` runs (`solidJsxPlugin`'s Babel
// pass, `solidProductionPlugin`'s export condition, `islandStylesPlugin`'s scope hashes). A Map
// walked in insertion order, a `Date` in a name or an unordered `Promise.all` result would land
// here. It does NOT pin Bun's tree-shaker, which is not reproducible in 1.4.0: a browser build
// drops `@ultimat3/core`'s `schema-error-codes.ts` — a module core's own `sideEffects` array
// NAMES — from some runs and not others, taking every `@ultimat3/schema` error title in that
// chunk with it (issues #273, #276).
//
// `feed.island.tsx` DOES reach that module, through `@ultimat3/realtime` -> `@ultimat3/core`, and
// is therefore excluded from byte EQUALITY. `posts/[id]/like.island.tsx` joined it on 2026-08-25
// for the same reason and by the same derivation, not by being listed. The other two islands
// imported no `@ultimat3/*` package until 2026-09-22 (plan 101, slice 16), when their raw `fetch`
// became the typed action client — so all four are now judged by the discriminator below, whose
// equality branch still demands byte-identical chunks whenever the shaker answers alike.
//
// **The root cause is UPSTREAM and this file is a workaround, not a fix.** Verified 2026-08-25
// against the registry: `packages/core/package.json` DECLARES `"./src/schema-error-codes.ts"` in
// its `sideEffects` array, and `bun run side-effects` agrees the declaration is true of the
// package. So Bun 1.4.0 is intermittently dropping a module its own package explicitly declares
// as side-effecting — which is the bundler ignoring `sideEffects`, not this repo mis-declaring it.
// Same family as oven-sh/bun#27709 (`sideEffects` mishandled by the bundler, OPEN, a 1.3.10
// regression from 1.3.9), though that report is deterministic where this is load-correlated.
//
// Do not "simplify" the discriminator away and do not re-derive the byte constant: neither is a
// local defect to repair. When Bun honours the declaration, this predicate goes quiet on its own
// (the two builds become byte-identical and the equality branch carries every run), and THAT is
// the signal the workaround can go.
//
// **The exclusion is a DISCRIMINATOR, never a byte allowance, and that is what this file got
// wrong.** It compared the two builds against a hand-copied `BUN_SHAKE_FLAP_BYTES = 512`,
// measured when the drop cost 379 B; `schema-error-codes.ts` then grew a `registerErrorRetry`
// table and the drop became 1,124 B on `feed` and 1,123 B on `like`, so the assertion started
// failing and the number said nothing about why. A measured constant describing somebody else's
// non-determinism goes stale in silence — the titles the module registers do not, because the
// module either reached the chunk whole or did not reach it at all.
//
// Measured 2026-08-25, 240 builds across six concurrent processes: exactly TWO byte-identical
// variants per impure island, told apart by those titles, and the drop is load-correlated — 0 in
// 80 builds on an idle machine, 22 in 240 under contention. That is why `x verify`'s `unit` step
// fails here on a free CI runner (six `bun test` shards, four cores) and passes on a laptop.
//
// The split is DERIVED, never listed: `frameworkImports` walks each island's own-source graph, so
// an import added to a pure island moves it into the excluded set loudly instead of turning this
// file flaky again.
//
// Both imports are public package specifiers, the same rule `settings.island.test.ts` follows.

import { dirname, join } from 'node:path';
import type { IslandChunk } from '@ultimat3/cli';
import { buildIslands } from '@ultimat3/cli';
import { SCHEMA_ERROR_CODE_TITLES } from '@ultimat3/core';
import { beforeAll, expect, test } from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');

/**
 * Whether the one module Bun 1.4.0 drops non-deterministically reached this chunk. Its four
 * registered TITLES are the evidence, because they are the module's whole payload — a chunk
 * carrying every one of them ran `registerErrorCodes` at import, and a chunk carrying none of
 * them was shaken. Read off `@ultimat3/core`'s own export rather than spelled here, so a title
 * edited there cannot leave this predicate quietly answering `false` for every build.
 *
 * `packages/ui/src/barrel-bytes.test.ts` had the same stale allowance and was repaired the same
 * day — but it could NOT use this predicate, and the reason matters here. `@ultimat3/ui` reaches
 * `@ultimat3/schema` through `money`, and schema's own `SCHEMA_ERROR_CODES` carries these four
 * titles verbatim (`packages/core/src/schema-error-codes.ts` calls itself "a deliberate, tested
 * duplicate"), so a ui chunk holds them whether core's module survived or not — always-`true`,
 * every flap routed to the equality branch, 3 reds in 240 pairs when it was tried. That file
 * discriminates on the module's own PATH instead, read out of Bun's `// <path>` banners.
 *
 * These islands reach schema too (`realtime` → `query` → `schema`) and are NOT affected, because
 * nothing an island calls touches that path so it shakes out, leaving only core's `sideEffects`-
 * pinned copy. Measured 2026-08-25 under six-way contention: the 43,890 B variant answers 4/4 and
 * the 42,766 B one answers 0/4. **If an island ever imports something that uses schema's error
 * path, this predicate goes always-`true` and this file starts failing on every flap** — that is
 * the thing to check first if it does.
 */
const carriesShakenModule = (chunk: IslandChunk): boolean =>
  Object.values(SCHEMA_ERROR_CODE_TITLES).every((title) => chunk.code.includes(title));

/**
 * One transpiler per loader, chosen by extension — the same rule `packages/cli/src/live-routes.ts`
 * follows for the same walk. Parsing a `.ts` as `tsx` reads `<T>(x: T) => …` as an unclosed JSX
 * element, so a plain module holding a generic arrow (`shared/live-socket.ts`) threw where the
 * island importing it built cleanly.
 */
const transpilers = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
} as const;
const transpilerFor = (file: string): Bun.Transpiler =>
  file.endsWith('x') ? transpilers.tsx : transpilers.ts;
const SPECIFIER_ENDINGS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];

/**
 * What the walk below can parse. An island MAY import a `.module.scss` — the island build runs
 * `loadStylesheet` over it — and handing that file to a `tsx` transpiler throws on its first rule
 * (`Unexpected .`). Nothing is lost by stopping there: a stylesheet cannot import a package
 * specifier, so no `sideEffects`-declared module can hide behind one.
 */
const SCANNABLE = /\.(?:tsx?|jsx?)$/;

async function resolveRelative(fromFile: string, specifier: string): Promise<string | null> {
  const base = join(dirname(fromFile), specifier);
  for (const ending of SPECIFIER_ENDINGS) {
    if (await Bun.file(`${base}${ending}`).exists()) return `${base}${ending}`;
  }
  return null;
}

/**
 * Every `@ultimat3/*` package an island's OWN sources reach, by walking relative imports and
 * stopping at package specifiers. That is the whole question: every module any `sideEffects` array
 * in this repo names lives inside an `@ultimat3/*` package, so an island that names none cannot
 * have one in its graph — a structural fact, where "we built it thirty times" is a sample.
 */
async function frameworkImports(entry: string): Promise<readonly string[]> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const imported of transpilerFor(file).scanImports(await Bun.file(file).text())) {
      if (imported.path.startsWith('.')) {
        const resolved = await resolveRelative(file, imported.path);
        if (resolved !== null && SCANNABLE.test(resolved)) queue.push(resolved);
      } else if (imported.path.startsWith('@ultimat3/')) {
        packages.add(imported.path);
      }
    }
  }
  return [...packages].sort();
}

/** `<file> <bytes> <url>` for one chunk — one string, so a failure prints what moved. */
const line = (chunk: IslandChunk): string => `${chunk.file} ${chunk.bytes} ${chunk.url}`;

/**
 * JavaScript's reserved words — the tokens a minifier never renames, so they stay in the skeleton.
 * Only what the minifier GENERATES is masked; `var` turning into `let` is a different program.
 */
const RESERVED = new Set(
  (
    'await break case catch class const continue debugger default delete do else export extends ' +
    'false finally for function if import in instanceof let new null of return static super ' +
    'switch this throw true try typeof undefined var void while with yield async get set'
  ).split(' '),
);

/** After one of these, a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void']);

/**
 * One pass over a minified chunk: every binding NAME in order, and the skeleton around them —
 * string, template and regular-expression literals verbatim, numbers, keywords, operators,
 * punctuation and property names after a `.` all kept, each name replaced by one marker.
 * Template text is literal and its `${…}` holes are code, so a name inside a hole is a name.
 */
function scan(code: string): { readonly skeleton: string; readonly names: readonly string[] } {
  const names: string[] = [];
  let out = '';
  let i = 0;
  let last = '';
  const holes: number[] = [];
  const quoted = (quote: string): void => {
    const start = i;
    i += 1;
    while (i < code.length && code[i] !== quote) i += code[i] === '\\' ? 2 : 1;
    i += 1;
    out += code.slice(start, i);
  };
  const template = (): void => {
    const start = i;
    while (i < code.length) {
      if (code[i] === '\\') i += 2;
      else if (code[i] === '`') {
        i += 1;
        out += code.slice(start, i);
        last = '`';
        return;
      } else if (code[i] === '$' && code[i + 1] === '{') {
        i += 2;
        out += code.slice(start, i);
        holes.push(0);
        last = '{';
        return;
      } else i += 1;
    }
    out += code.slice(start);
  };
  while (i < code.length) {
    const c = code[i] as string;
    if (c === '"' || c === "'") {
      quoted(c);
      last = c;
    } else if (c === '`') {
      i += 1;
      out += '`';
      template();
    } else if (c === '{' && holes.length > 0) {
      holes[holes.length - 1] = (holes.at(-1) ?? 0) + 1;
      out += c;
      i += 1;
      last = c;
    } else if (c === '}' && holes.length > 0 && holes.at(-1) === 0) {
      holes.pop();
      out += c;
      i += 1;
      template();
    } else if (c === '/' && (last === '' || REGEX_AFTER.has(last) || REGEX_AFTER_WORD.has(last))) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < code.length && (code[i] !== '/' || inClass)) {
        if (code[i] === '\\') i += 1;
        else if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      while (i < code.length && /[a-z]/.test(code[i] as string)) i += 1;
      out += code.slice(start, i);
      last = ')';
    } else if (/\d/.test(c)) {
      const match = /^\d[\w.]*/.exec(code.slice(i, i + 64)) as RegExpExecArray;
      out += match[0];
      i += match[0].length;
      last = '0';
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = (/^[A-Za-z_$][\w$]*/.exec(code.slice(i, i + 256)) as RegExpExecArray)[0];
      const property = out.endsWith('.') && !out.endsWith('..');
      if (property || RESERVED.has(word)) out += word;
      else {
        out += '\u0001';
        names.push(word);
      }
      i += word.length;
      last = RESERVED.has(word) ? word : 'a';
    } else {
      if (c === '}' && holes.length > 0) holes[holes.length - 1] = (holes.at(-1) ?? 1) - 1;
      out += c;
      i += 1;
      if (c.trim() !== '') last = c;
    }
  }
  return { skeleton: out, names };
}

/**
 * Two chunks are the same program up to what their bindings are called when their skeletons are
 * equal AND the names map one-to-one: every occurrence of `dt` in one is the same name in the
 * other, and no two names collapse into one. That is exactly and only what `oven-sh/bun#40657`
 * varies — it renames, it never merges or splits a binding.
 */
function sameUpToRenaming(before: string, after: string): boolean {
  const a = scan(before);
  const b = scan(after);
  if (a.skeleton !== b.skeleton || a.names.length !== b.names.length) return false;
  const forward = new Map<string, string>();
  const backward = new Map<string, string>();
  for (const [index, name] of a.names.entries()) {
    const other = b.names[index] as string;
    if ((forward.get(name) ?? other) !== other || (backward.get(other) ?? name) !== name) {
      return false;
    }
    forward.set(name, other);
    backward.set(other, name);
  }
  return true;
}

/**
 * The SECOND upstream flap, and it is not the shaker's — `oven-sh/bun#40657`. `Bun.build` with
 * `minify: true` answers two different chunks for one unchanged input, differing only in generated
 * identifier names (`dt`↔`at`, `hr`↔`mr`, `Pn`↔`Jn`, …). Reproduced on 1.3.14, 1.4.0 and
 * 1.4.1-canary; `minify: false` and `minify: { identifiers: false }` are both deterministic, and it
 * is load-correlated the same way the shaker flap is — which is why it fails on a free CI runner
 * and passes on a laptop.
 *
 * **It can move the byte count, and this file used to say it could not.** The names are assigned
 * by frequency and the ties are what flap, so a binding can land on a one-character name in one
 * build and a two-character name in the next. CI run 35815786302 (2026-09-23) failed on exactly
 * that: `contact-sales.island.tsx` 19,858 against 19,857 B, both builds carrying the shaken
 * module, so no other difference was possible. 200 local builds under 2-core contention and 40
 * test runs never reproduced it; the runner did.
 *
 * `identifiers: false` was measured as the in-tree fix and REFUSED: it costs +45% —
 * `feed.island.tsx` 45,925 → 66,542 B and `like.island.tsx` 48,688 → 70,215 B. Trading a real
 * budget for somebody else's determinism bug is the wrong way round.
 *
 * So a rename is tolerated, and tolerated NARROWLY: the two chunks must have ONE skeleton —
 * every string, template, regular expression, number, keyword, operator and property name in the
 * same place — and their binding names must map one-to-one. A plugin emitting different code, a
 * `Date` in a literal, an unordered `Promise.all`, a module dropped or duplicated, two bindings
 * merged: each breaks one of the two and still fails.
 */
const renamedOnly = (before: IslandChunk, after: IslandChunk): boolean =>
  before.code !== after.code && sameUpToRenaming(before.code, after.code);

/**
 * One chunk against its rebuild: byte-identical, or identical up to `oven-sh/bun#40657`'s
 * renaming. A byte count that moved is accepted ONLY as a rename's — the skeleton proves nothing
 * but names changed, and a name is a few bytes a budget's headroom has to hold anyway.
 */
function expectSameChunk(before: IslandChunk, after: IslandChunk): void {
  if (after.url === before.url && after.bytes === before.bytes) return;
  expect(renamedOnly(before, after), `${line(before)} -> ${line(after)}`).toBe(true);
}

const byFile = async (): Promise<ReadonlyMap<string, IslandChunk>> =>
  new Map((await buildIslands(APP_ROOT)).chunks.map((chunk) => [chunk.file, chunk]));

/**
 * The SECOND build, in a process of its own — and it has to be. `buildIslands` answers the FIRST
 * code it emitted for an unchanged source graph for as long as the process lives (`stableCode` in
 * `packages/cli/src/island-bundle.ts`, so one URL serves one byte string), which made a second
 * in-process build hand back the first one's code: every "byte-identical" below compared a cached
 * string to itself and proved nothing. Worse, its `bytes` is measured on the FRESH output while
 * its `code` is the cached one, so a length-changing rename surfaced as two byte counts over one
 * code — the CI failure this file was repaired for, undiagnosable from inside. A child process has
 * no cache, which is also what two real builds are: two machines, two processes.
 */
async function byFileInChildProcess(): Promise<ReadonlyMap<string, IslandChunk>> {
  const script =
    "const { buildIslands } = await import('@ultimat3/cli');" +
    `const built = await buildIslands(${JSON.stringify(APP_ROOT)});` +
    'await Bun.write(Bun.stdout, JSON.stringify(built.chunks));';
  const child = Bun.spawn(['bun', '-e', script], { cwd: APP_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) expect.unreachable(`the second build exited ${code}:\n${err}`);
  const chunks = JSON.parse(out) as readonly IslandChunk[];
  return new Map(chunks.map((chunk) => [chunk.file, chunk]));
}

/** Both builds up front: `fixtureTest` takes no timeout, and a Babel pass is not a 5s budget. */
let first: ReadonlyMap<string, IslandChunk> = new Map();
let second: ReadonlyMap<string, IslandChunk> = new Map();
let reachable: ReadonlyMap<string, readonly string[]> = new Map();

beforeAll(async () => {
  first = await byFile();
  second = await byFileInChildProcess();
  reachable = new Map(
    await Promise.all(
      [...first.keys()].map(
        async (file): Promise<[string, readonly string[]]> => [
          file,
          await frameworkImports(join(APP_ROOT, file)),
        ],
      ),
    ),
  );
}, 120_000);

test('every island in the app is measured, and each is classified by its own graph', () => {
  // Not empty: an app that discovered no island would satisfy every assertion below by having
  // nothing to compare, which is the vacuous green this whole file is an argument against.
  expect([...first.keys()].sort()).toEqual([
    'apps/web/app/feed/feed.island.tsx',
    'apps/web/app/posts/[id]/like.island.tsx',
    'apps/web/app/posts/[id]/likes-badge.island.tsx',
    'apps/web/app/settings/settings.island.tsx',
    'apps/web/app/update-banner.island.tsx',
    'apps/web/site/pricing/contact-sales.island.tsx',
  ]);
  // Plain DOM; `@ultimat3/core/page` — constants only — for the two names it shares with the
  // worker and the render. Never the core barrel, which was 8,344 B of a 710 B chunk.
  expect(reachable.get('apps/web/app/update-banner.island.tsx')).toEqual(['@ultimat3/core/page']);
  // `@ultimat3/time` for the row's date, day only (`formatDate`) — already in the chunk through ui.
  expect(reachable.get('apps/web/app/feed/feed.island.tsx')).toEqual([
    '@ultimat3/realtime',
    '@ultimat3/time',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/app/posts/[id]/like.island.tsx')).toEqual(['@ultimat3/realtime']);
  expect(reachable.get('apps/web/app/posts/[id]/likes-badge.island.tsx')).toEqual([
    '@ultimat3/realtime',
  ]);
  // Both reach the typed action client through `shared/browser-client.ts` (plan 101, slice 16):
  // no island hand-rolls a `fetch` any more, so no island is free of `@ultimat3/*`.
  expect(reachable.get('apps/web/app/settings/settings.island.tsx')).toEqual(['@ultimat3/action']);
  expect(reachable.get('apps/web/site/pricing/contact-sales.island.tsx')).toEqual([
    '@ultimat3/action',
  ]);
});

test('the module the shaker drops is one a package still declares as a side effect', async () => {
  // The exclusion below rests on this being true. If core stops declaring it, the reason feed is
  // exempt has changed and this file has to be re-derived rather than quietly kept.
  const manifest = (await Bun.file(join(REPO_ROOT, 'packages/core/package.json')).json()) as {
    sideEffects?: readonly string[];
  };
  expect(manifest.sideEffects ?? []).toContain('./src/schema-error-codes.ts');
});

test('no island is pure any more, so the discriminator below judges every one', () => {
  // Kept as an assertion rather than deleted: an island that drops its last `@ultimat3/*` import
  // becomes pure again and must then be byte-identical outright, which this test is where to add.
  const pure = [...first.keys()].filter((file) => (reachable.get(file) ?? []).length === 0);
  expect(pure).toEqual([]);
});

test('the rename tolerance is narrow: only binding names may differ, whatever they cost', () => {
  const chunk = (code: string): IslandChunk =>
    ({
      file: 'x.island.tsx',
      url: `/islands/x-${code.length}.js`,
      code,
      bytes: code.length,
    }) as IslandChunk;

  // A rename at the same length — the flap as first reported.
  expect(renamedOnly(chunk('var dt=1,q="a";f(dt)'), chunk('var at=1,q="a";f(at)'))).toBe(true);
  // A rename that MOVES the byte count — CI run 35815786302's 19,858 → 19,857.
  expect(renamedOnly(chunk('var dt=1,q="a";f(dt)'), chunk('var d=1,q="a";f(d)'))).toBe(true);
  // A literal moved — the shape a plugin change or a wrong `define` takes.
  expect(renamedOnly(chunk('var dt=1,q="a"'), chunk('var at=1,q="b"'))).toBe(false);
  // A literal grew: the byte count moved and it is NOT a rename.
  expect(renamedOnly(chunk('var dt=1,q="a"'), chunk('var at=1,q="aa"'))).toBe(false);
  // An operator changed at the same length — names alone cannot explain it.
  expect(renamedOnly(chunk('f(a+b)'), chunk('f(a-b)'))).toBe(false);
  // A keyword changed: `var` to `let` is a different program, not a different name.
  expect(renamedOnly(chunk('var a=1'), chunk('let a=1'))).toBe(false);
  // A property name is not a binding — a minifier never renames one it cannot prove private.
  expect(renamedOnly(chunk('a.foo(1)'), chunk('a.bar(1)'))).toBe(false);
  // A statement dropped — a shaken module, or a plugin emitting less.
  expect(renamedOnly(chunk('f(a);g(b)'), chunk('f(a)'))).toBe(false);
  // A number changed.
  expect(renamedOnly(chunk('f(1e3)'), chunk('f(1e4)'))).toBe(false);
  // Two bindings merged into one name is not a rename — the program changed.
  expect(renamedOnly(chunk('f(a,b)'), chunk('f(c,c)'))).toBe(false);
  // Template text is literal; a name inside its `${…}` hole is a name.
  expect(renamedOnly(chunk(`f(\`x \${ab} y\`)`), chunk(`f(\`x \${c} y\`)`))).toBe(true);
  expect(renamedOnly(chunk(`f(\`x \${ab} y\`)`), chunk(`f(\`z \${ab} y\`)`))).toBe(false);
  // A regular expression is literal too, words and all.
  expect(renamedOnly(chunk('f(/abc/g,a)'), chunk('f(/abcd/g,b)'))).toBe(false);
  expect(renamedOnly(chunk('f(/abc/g,a)'), chunk('f(/abc/g,bc)'))).toBe(true);
  // Division is not a regular expression.
  expect(renamedOnly(chunk('x=a/b/c'), chunk('x=d/e/f'))).toBe(true);
  // Byte-identical is not this branch's business; the caller returns before asking.
  expect(renamedOnly(chunk('var dt=1'), chunk('var dt=1'))).toBe(false);
});

test('an island that reaches a side-effecting module differs by that module and by nothing else', () => {
  const impure = [...first.keys()].filter((file) => (reachable.get(file) ?? []).length > 0);
  expect(impure).toHaveLength(6);
  for (const file of impure) {
    const before = first.get(file) as IslandChunk;
    const after = second.get(file) as IslandChunk;
    if (carriesShakenModule(before) === carriesShakenModule(after)) {
      // The shaker answered the same way twice, so the build chain owes byte EQUALITY — the same
      // thing the pure islands owe, and STRICTER than the allowance this replaced, which waved
      // through any difference under 512 B whatever caused it.
      expectSameChunk(before, after);
      continue;
    }
    // It answered differently, and then the chunk holding the module is the bigger one, always.
    // A build that grew while LOSING the module is something other than the shaker moving, which
    // is the condition this file exists to catch; the equality branch above is what holds a
    // second difference riding along, since a mismatched pair has no byte statement to make.
    const bigger = after.bytes > before.bytes ? after : before;
    expect(carriesShakenModule(bigger)).toBe(true);
  }
});
