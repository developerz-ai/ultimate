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
// NAMES — from some runs and not others, costing 379 B and every `@ultimat3/schema` error title
// in that chunk (issues #273, #276).
//
// `feed.island.tsx` DOES reach that module, through `@ultimat3/realtime` -> `@ultimat3/core`, and
// is therefore excluded from byte EQUALITY: measured 2026-08-23, 300 builds in one process, it
// flips between 42,335 B and 42,714 B with no source change. The 12 consecutive builds this file
// once called proof were a sample too small to see a ~5%-per-build event — run 8 of 12 flipped
// when the sample was repeated. `posts/[id]/like.island.tsx` joined it on 2026-08-25 for the same
// reason and by the same derivation, not by being listed. The other two islands import no
// `@ultimat3/*` package at all, so no `sideEffects`-declared module can be in their graph however
// the shaker feels that run, and they were stable across the same 300 builds.
//
// The split is DERIVED, never listed: `frameworkImports` walks each island's own-source graph, so
// an import added to a pure island moves it into the excluded set loudly instead of turning this
// file flaky again.
//
// Both imports are public package specifiers, the same rule `settings.island.test.ts` follows.

import { dirname, join } from 'node:path';
import type { IslandChunk } from '@ultimat3/cli';
import { buildIslands } from '@ultimat3/cli';
import { beforeAll, expect, test } from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..');
const REPO_ROOT = join(APP_ROOT, '..', '..');

/**
 * How far two builds of one unchanged island may disagree. Not cosmetic: it is the size of the
 * one module Bun 1.4.0 drops non-deterministically, and `packages/ui/src/barrel-bytes.test.ts`
 * carries the same number for the same reason. Anything a real source change costs is larger.
 */
const BUN_SHAKE_FLAP_BYTES = 512;

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

test('an island that reaches a side-effecting module moves by the shaker flap and no more', () => {
  const impure = [...first.keys()].filter((file) => (reachable.get(file) ?? []).length > 0);
  expect(impure).toHaveLength(2);
  for (const file of impure) {
    const before = (first.get(file) as IslandChunk).bytes;
    const after = (second.get(file) as IslandChunk).bytes;
    // A real source change costs more than one dropped module; anything bigger than the flap is
    // this build chain being unreproducible, which is what the file is here to catch.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(BUN_SHAKE_FLAP_BYTES);
  }
});
