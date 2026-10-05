// Two builds of an unchanged tree publish every island as the same bytes under the same URL.
//
// `IslandChunk.url` names a chunk for good, so a build that is not byte-reproducible is an
// immutable URL that is not immutable: a CDN, a precache manifest and a deploy that diffs
// artefacts all see a change that is not one, and the `budgets` gate step measures a moving
// number (issue #273). Nothing anywhere asserted this.
//
// It pins the plugin chain `buildIslands` runs (`solidJsxPlugin`'s Babel pass,
// `solidProductionPlugin`'s export condition, `islandStylesPlugin`'s scope hashes) — a Map walked
// in insertion order, a `Date` in a name or an unordered `Promise.all` result lands here — AND
// Bun's own bundler, which until 1.4.1 was not reproducible in two ways this file used to tolerate
// (issue #354):
//
// | flap | upstream | what moved |
// |---|---|---|
// | retention | oven-sh/bun#40650 | a `sideEffects` ARRAY read as `false`: core's `schema-error-codes.ts` shaken from some builds |
// | byte identity | oven-sh/bun#40657 | `minify` renaming bindings differently per build (`dt`↔`at`), sometimes moving the byte count |
//
// Both are fixed upstream in 1.4.1, and the tolerance for each — a discriminator on the shaken
// module's titles, and a rename-only skeleton comparison — is deleted. **Measured 2026-10-05 on Bun
// 1.4.2 (`744846f8`)**, this file's own child-process build, two batches of 96 pairs (12 and 16
// concurrent workers, load average 28-32 on 12 cores): **192 pairs, 1,344 island pairs, 0
// retention flaps, 0 byte-identity flaps** — exactly one byte string per island across 384 builds.
// Before: 12 retention flaps in 60 pairs on 1.4.0 (issue #354's probe, pre-#399) and a
// byte-identity flap in 1-2 of 10 runs of this file. So a difference here is now a finding, never the weather: a plugin, a
// map order, or Bun regressing — bisect the Bun version before touching the plugin chain.
//
// The #399 anchors (`SIDE_EFFECTS_ANCHORS`, `scripts/lib/side-effects-scan.ts`) stay: they are what
// keeps the retention test below deterministic on any bundler, not only on one that honours the
// array.
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
 * Whether `@ultimat3/core`'s `schema-error-codes.ts` reached this chunk. Its four registered
 * TITLES are the evidence, because they are the module's whole payload — a chunk carrying every
 * one of them ran `registerErrorCodes` at import, and a chunk carrying none of them was shaken.
 * Read off core's own export rather than spelled here, so a title edited there cannot leave this
 * predicate quietly answering `false` for every build.
 *
 * `packages/ui/src/barrel-bytes.test.ts` cannot use this predicate: `@ultimat3/ui` reaches
 * `@ultimat3/schema` through `money`, whose `SCHEMA_ERROR_CODES` carries these titles verbatim, so
 * a ui chunk holds them either way. These islands reach schema too (`realtime` → `query` →
 * `schema`), but nothing an island calls touches schema's error path, so only core's anchored copy
 * is left. **If an island ever imports something that uses schema's error path, this predicate
 * goes always-`true`** — check that first if the retention test below stops being able to fail.
 */
const carriesRegisteredTitles = (chunk: IslandChunk): boolean =>
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
 * specifier.
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
 * stopping at package specifiers — a structural fact about the graph, where "we built it thirty
 * times" is a sample. It is what the retention test derives its expected set from.
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
 * `@ultimat3/core/page` is constants only and reaches no error registry; every other framework
 * entry an island imports reaches core's barrel, and with it the anchored module.
 */
const CONSTANTS_ONLY = '@ultimat3/core/page';

const byFile = async (): Promise<ReadonlyMap<string, IslandChunk>> =>
  new Map((await buildIslands(APP_ROOT)).chunks.map((chunk) => [chunk.file, chunk]));

/**
 * The SECOND build, in a process of its own — and it has to be. `buildIslands` answers the FIRST
 * code it emitted for an unchanged source graph for as long as the process lives (`stableChunk` in
 * `packages/cli/src/island-identity.ts`, so one URL serves one byte string), which made a second
 * in-process build hand back the first one's code: every "byte-identical" below compared a cached
 * string to itself and proved nothing. A child process has no cache, which is also what two real
 * builds are: two machines, two processes.
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
    'apps/web/app/runs/run-console.island.tsx',
    'apps/web/app/settings/settings.island.tsx',
    'apps/web/app/update-banner.island.tsx',
    'apps/web/site/pricing/contact-sales.island.tsx',
  ]);
  // Plain DOM; `@ultimat3/core/page` — constants only — for the two names it shares with the
  // worker and the render. Never the core barrel, which was 8,344 B of a 710 B chunk.
  expect(reachable.get('apps/web/app/update-banner.island.tsx')).toEqual([CONSTANTS_ONLY]);
  // `@ultimat3/time` for the row's date, day only (`formatDate`) — already in the chunk through ui.
  expect(reachable.get('apps/web/app/feed/feed.island.tsx')).toEqual([
    '@ultimat3/realtime',
    '@ultimat3/time',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/app/posts/[id]/like.island.tsx')).toEqual(['@ultimat3/realtime']);
  // The run console: the live read, the design system's region and controls, the typed action
  // client for its four writes, and core's page entry for `isSuperseded`.
  expect(reachable.get('apps/web/app/runs/run-console.island.tsx')).toEqual([
    '@ultimat3/action',
    CONSTANTS_ONLY,
    '@ultimat3/realtime',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/app/posts/[id]/likes-badge.island.tsx')).toEqual([
    '@ultimat3/realtime',
  ]);
  // Both reach the typed action client through `shared/browser-client.ts` (plan 101, slice 16).
  expect(reachable.get('apps/web/app/settings/settings.island.tsx')).toEqual(['@ultimat3/action']);
  expect(reachable.get('apps/web/site/pricing/contact-sales.island.tsx')).toEqual([
    '@ultimat3/action',
  ]);
});

test('the module retention is judged by is one a package still declares as a side effect', async () => {
  // The retention test below rests on this being true. If core stops declaring it, the reason
  // the titles must be present has changed and that test has to be re-derived, not kept.
  const manifest = (await Bun.file(join(REPO_ROOT, 'packages/core/package.json')).json()) as {
    sideEffects?: readonly string[];
  };
  expect(manifest.sideEffects ?? []).toContain('./src/schema-error-codes.ts');
});

test('every island reaching core keeps its side-effecting module, in both builds', () => {
  // The retention flap's other face: oven-sh/bun#40650 on 1.3.14 dropped the module from BOTH
  // builds of one process, which byte equality alone reads as agreement. The expected set is
  // derived from each island's graph, so an import change moves an island loudly.
  const expected = [...first.keys()]
    .filter((file) => (reachable.get(file) ?? []).some((pkg) => pkg !== CONSTANTS_ONLY))
    .sort();
  expect(expected).toHaveLength(6);
  for (const build of [first, second]) {
    const carrying = [...build.values()]
      .filter(carriesRegisteredTitles)
      .map((chunk) => chunk.file)
      .sort();
    expect(carrying).toEqual(expected);
  }
});

test('every island is byte-identical to its rebuild in another process', () => {
  expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
  for (const [file, before] of first) {
    const after = second.get(file) as IslandChunk;
    // URL and size first, so a failure names the island instead of printing 100 kB of chunk. The
    // URL is source-addressed (`graphHash`), so it alone cannot see a bundler that emits other
    // bytes for one graph — the code comparison is the claim, and it has no tolerance.
    expect(line(after)).toBe(line(before));
    expect(after.code === before.code, `${line(before)}: same length, different bytes`).toBe(true);
  }
});
