// Two builds of an unchanged tree publish the same island under the same URL.
//
// `IslandChunk.url` is `contentHash(code)`, so a build that is not byte-reproducible is an
// immutable URL that is not immutable: a CDN, a precache manifest and a deploy that diffs
// artefacts all see a change that is not one, and the `budgets` gate step measures a moving
// number (issue #273). Nothing anywhere asserted this.
//
// It pins the half that is OURS — the plugin chain `buildIslands` runs (`solidJsxPlugin`'s Babel
// pass, `solidProductionPlugin`'s export condition, `islandStylesPlugin`'s scope hashes). A Map
// walked in insertion order, a `Date` in a name or an unordered `Promise.all` result would land
// here. It does NOT pin Bun's tree-shaker, which is not reproducible in 1.4.0: measured
// 2026-08-23, roughly one browser build in seventy drops `@ultimat3/core`'s
// `schema-error-codes.ts` — a module core's own `sideEffects` array NAMES — costing 377 B and
// every `@ultimat3/schema` error title in that chunk. This app's two islands cannot flip that way
// and that is why they are the fixture: neither graph reaches a `sideEffects`-declared module.
//
// Both imports are public package specifiers, the same rule `settings.island.test.ts` follows.

import { join } from 'node:path';
import { buildIslands } from '@ultimat3/cli';
import { beforeAll, expect, test } from '@ultimat3/testing';

const APP_ROOT = join(import.meta.dir, '..', '..');

/** `<file> <bytes> <url>` per island, sorted — one string, so a failure prints the whole table. */
async function fingerprint(): Promise<string> {
  const bundle = await buildIslands(APP_ROOT);
  return bundle.chunks
    .map((chunk) => `${chunk.file} ${chunk.bytes} ${chunk.url}`)
    .sort()
    .join('\n');
}

/** Both builds up front: `fixtureTest` takes no timeout, and a Babel pass is not a 5s budget. */
let first = '';
let second = '';

beforeAll(async () => {
  first = await fingerprint();
  second = await fingerprint();
}, 120_000);

test('buildIslands is byte-reproducible, so an island URL is content-addressed and stable', () => {
  // Not empty: an app that discovered no island would satisfy equality by having nothing to
  // compare, which is the vacuous green this whole file is an argument against.
  expect(first.split('\n')).toHaveLength(2);
  expect(second).toBe(first);
});
