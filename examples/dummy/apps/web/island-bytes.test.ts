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
// import no `@ultimat3/*` package at all, so no `sideEffects`-declared module can be in their
// graph however the shaker feels that run, and they were stable across the same runs.
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

const byFile = async (): Promise<ReadonlyMap<string, IslandChunk>> =>
  new Map((await buildIslands(APP_ROOT)).chunks.map((chunk) => [chunk.file, chunk]));

/** Both builds up front: `fixtureTest` takes no timeout, and a Babel pass is not a 5s budget. */
let first: ReadonlyMap<string, IslandChunk> = new Map();
let second: ReadonlyMap<string, IslandChunk> = new Map();
let reachable: ReadonlyMap<string, readonly string[]> = new Map();

beforeAll(async () => {
  first = await byFile();
  second = await byFile();
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
    'apps/web/app/settings/settings.island.tsx',
    'apps/web/site/pricing/contact-sales.island.tsx',
  ]);
  expect(reachable.get('apps/web/app/feed/feed.island.tsx')).toEqual(['@ultimat3/realtime']);
  expect(reachable.get('apps/web/app/posts/[id]/like.island.tsx')).toEqual(['@ultimat3/realtime']);
  expect(reachable.get('apps/web/app/settings/settings.island.tsx')).toEqual([]);
  expect(reachable.get('apps/web/site/pricing/contact-sales.island.tsx')).toEqual([]);
});

test('the module the shaker drops is one a package still declares as a side effect', async () => {
  // The exclusion below rests on this being true. If core stops declaring it, the reason feed is
  // exempt has changed and this file has to be re-derived rather than quietly kept.
  const manifest = (await Bun.file(join(REPO_ROOT, 'packages/core/package.json')).json()) as {
    sideEffects?: readonly string[];
  };
  expect(manifest.sideEffects ?? []).toContain('./src/schema-error-codes.ts');
});

test('buildIslands is byte-reproducible for every island the shaker answers the same way', () => {
  const pure = [...first.keys()].filter((file) => (reachable.get(file) ?? []).length === 0).sort();
  expect(pure).toHaveLength(2);

  const at = (build: ReadonlyMap<string, IslandChunk>): readonly string[] =>
    pure.map((file) => line(build.get(file) as IslandChunk));
  expect(at(second)).toEqual(at(first));
});

test('an island that reaches a side-effecting module differs by that module and by nothing else', () => {
  const impure = [...first.keys()].filter((file) => (reachable.get(file) ?? []).length > 0);
  expect(impure).toHaveLength(2);
  for (const file of impure) {
    const before = first.get(file) as IslandChunk;
    const after = second.get(file) as IslandChunk;
    if (carriesShakenModule(before) === carriesShakenModule(after)) {
      // The shaker answered the same way twice, so the build chain owes byte EQUALITY — the same
      // thing the pure islands owe, and STRICTER than the allowance this replaced, which waved
      // through any difference under 512 B whatever caused it.
      expect(line(after)).toBe(line(before));
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
