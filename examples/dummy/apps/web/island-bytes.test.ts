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
import type { IslandChunk, SharedChunk } from '@ultimat3/cli';
import { buildIslands } from '@ultimat3/cli';
import { SCHEMA_ERROR_CODE_TITLES } from '@ultimat3/core';
import { REALTIME_PAGE_ERROR_TITLES } from '@ultimat3/realtime';
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
 * `scripts/ui-barrel-bytes.test.ts` cannot use this predicate: `@ultimat3/ui` reaches
 * `@ultimat3/schema` through `money`, whose `SCHEMA_ERROR_CODES` carries these titles verbatim, so
 * a ui chunk holds them either way. These islands reach schema too (`realtime` → `query` →
 * `schema`), but nothing an island calls touches schema's error path, so only core's anchored copy
 * is left. **If an island ever imports something that uses schema's error path, this predicate
 * goes always-`true`** — check that first if the retention test below stops being able to fail.
 */
const carriesRegisteredTitles = (code: string): boolean =>
  Object.values(SCHEMA_ERROR_CODE_TITLES).every((title) => code.includes(title));

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
 * entry an island imports reaches core's barrel, and with it the anchored module — bar the one
 * named below.
 */
const CONSTANTS_ONLY = '@ultimat3/core/page';

/**
 * `@ultimat3/realtime`'s client barrel registers its OWN titles (`error-titles.ts`, its one listed
 * side effect) through `@ultimat3/core/page`, never core's barrel — so an island whose only
 * framework import is realtime carries realtime's table and neither of core's anchored ones
 * (27.6.0; through the barrel each such island paid 4,571 B minified for two tables it never
 * read). Retention is still asserted for these islands below, on the table they DO anchor.
 */
const OWN_TITLES_ONLY = '@ultimat3/realtime';

/**
 * The typed action client reaches core through `@ultimat3/core/page` only (plan 101 slice 11, K6:
 * `client.ts` imported core's barrel), so an island whose only framework import is the action
 * client carries neither of core's anchored tables — `summary` and `contact-sales` paid both.
 */
const LEAN_ACTION_CLIENT = '@ultimat3/action';

/** Whether realtime's anchored titles module reached this chunk: every title, as for core's. */
const carriesRealtimeTitles = (code: string): boolean =>
  Object.values(REALTIME_PAGE_ERROR_TITLES).every((title) => code.includes(title));

/** One build: each island's entry by file, and the code of every shared chunk by URL. */
interface Built {
  readonly chunks: ReadonlyMap<string, IslandChunk>;
  readonly shared: ReadonlyMap<string, string>;
}

const builtFrom = (chunks: readonly IslandChunk[], shared: readonly SharedChunk[]): Built => ({
  chunks: new Map(chunks.map((chunk) => [chunk.file, chunk])),
  shared: new Map(shared.map((one) => [one.url, one.code])),
});

const byFile = async (): Promise<Built> => {
  // `reuse: false` in both builds: a group read back from `.x/cache/islands` is the other build's
  // bytes replayed, and this file is about the bundler emitting them.
  const bundle = await buildIslands(APP_ROOT, { reuse: false });
  return builtFrom(bundle.chunks, bundle.shared);
};

/**
 * Everything booting `chunk` loads: its entry and every shared chunk in its import closure. Islands
 * one route renders together are one split build (`packages/cli/src/island-groups.ts`), so a module
 * two of them import — realtime's titles for `like` and `likes-badge` — sits in a shared chunk
 * both load, not inline in either entry.
 */
const loaded = (chunk: IslandChunk, build: Built): string =>
  [chunk.code, ...chunk.imports.map((url) => build.shared.get(url) ?? '')].join('\n');

/**
 * The SECOND build, in a process of its own — and it has to be. `buildIslands` answers the FIRST
 * code it emitted under one identity for as long as the process lives (`stableChunk` in
 * `packages/cli/src/island-identity.ts`, so one URL serves one byte string), which made a second
 * in-process build hand back the first one's code: every "byte-identical" below compared a cached
 * string to itself and proved nothing. A child process has no cache, which is also what two real
 * builds are: two machines, two processes.
 */
async function byFileInChildProcess(): Promise<Built> {
  const script =
    "const { buildIslands } = await import('@ultimat3/cli');" +
    `const built = await buildIslands(${JSON.stringify(APP_ROOT)}, { reuse: false });` +
    'await Bun.write(Bun.stdout, JSON.stringify({ chunks: built.chunks, shared: built.shared }));';
  const child = Bun.spawn(['bun', '-e', script], { cwd: APP_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) expect.unreachable(`the second build exited ${code}:\n${err}`);
  const parsed = JSON.parse(out) as {
    readonly chunks: readonly IslandChunk[];
    readonly shared: readonly SharedChunk[];
  };
  return builtFrom(parsed.chunks, parsed.shared);
}

/** Both builds up front: `fixtureTest` takes no timeout, and a Babel pass is not a 5s budget. */
let firstBuild: Built = { chunks: new Map(), shared: new Map() };
let secondBuild: Built = { chunks: new Map(), shared: new Map() };
let first: ReadonlyMap<string, IslandChunk> = new Map();
let second: ReadonlyMap<string, IslandChunk> = new Map();
let reachable: ReadonlyMap<string, readonly string[]> = new Map();

beforeAll(async () => {
  firstBuild = await byFile();
  secondBuild = await byFileInChildProcess();
  first = firstBuild.chunks;
  second = secondBuild.chunks;
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
    'apps/web/app/posts/[id]/summary.island.tsx',
    'apps/web/app/posts/board/board.island.tsx',
    'apps/web/app/runs/run-console.island.tsx',
    'apps/web/app/settings/settings.island.tsx',
    'apps/web/app/update-banner.island.tsx',
    'apps/web/site/pricing/contact-sales.island.tsx',
  ]);
  // Plain DOM; `@ultimat3/core/page` — constants only — for the two names it shares with the
  // worker and the render. Never the core barrel, which was 8,344 B of a 710 B chunk.
  expect(reachable.get('apps/web/app/update-banner.island.tsx')).toEqual([CONSTANTS_ONLY]);
  // `@ultimat3/time` for the row's date, day only (`formatDate`) — already in the chunk through ui.
  // `@ultimat3/i18n/subset` for the design system's strings the server resolved (`uiCatalog`): the
  // translator alone, never the i18n barrel and the framework catalog it installs.
  // `@ultimat3/render/client` for the palette's `navigate()`: through the router, never the barrel.
  expect(reachable.get('apps/web/app/feed/feed.island.tsx')).toEqual([
    '@ultimat3/i18n/subset',
    '@ultimat3/realtime',
    '@ultimat3/render/client',
    '@ultimat3/time',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/app/posts/[id]/like.island.tsx')).toEqual(['@ultimat3/realtime']);
  // The run console: the live read, the design system's region and controls, the typed action
  // client for its four writes, and core's page entry for `isSuperseded`. The runs page's "created
  // between" filter (`DateRangePicker`'s calendar) is drawn inside it, so it adds no package.
  expect(reachable.get('apps/web/app/runs/run-console.island.tsx')).toEqual([
    '@ultimat3/action',
    CONSTANTS_ONLY,
    '@ultimat3/i18n/subset',
    '@ultimat3/realtime',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/app/posts/[id]/likes-badge.island.tsx')).toEqual([
    '@ultimat3/realtime',
  ]);
  // Both reach the typed action client through `shared/browser-client.ts` (plan 101, slice 16).
  // Settings also subscribes this browser to Web Push: `@ultimat3/pwa/client`, which imports nothing.
  // The time zone is `@ultimat3/ui`'s SearchableSelect, its strings the server's through
  // `@ultimat3/i18n/subset` (plan 101, 23-ui-searchable-select).
  expect(reachable.get('apps/web/app/settings/settings.island.tsx')).toEqual([
    '@ultimat3/action',
    '@ultimat3/i18n/subset',
    '@ultimat3/pwa/client',
    '@ultimat3/ui',
  ]);
  expect(reachable.get('apps/web/site/pricing/contact-sales.island.tsx')).toEqual([
    '@ultimat3/action',
  ]);
  // The posts board: `@ultimat3/ui`'s `Board`, its strings the server's, and `movePostStatus`
  // through the typed action client (plan 101, 38-ui-drag-layout).
  expect(reachable.get('apps/web/app/posts/board/board.island.tsx')).toEqual([
    '@ultimat3/action',
    '@ultimat3/i18n/subset',
    '@ultimat3/ui',
  ]);
  // The summary streams `summarize` through the typed client's `.stream()` and nothing else.
  expect(reachable.get('apps/web/app/posts/[id]/summary.island.tsx')).toEqual(['@ultimat3/action']);
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
  const reaching = (through: (pkg: string) => boolean): string[] =>
    [...first.keys()].filter((file) => (reachable.get(file) ?? []).some(through)).sort();
  const expected = reaching(
    (pkg) => pkg !== CONSTANTS_ONLY && pkg !== OWN_TITLES_ONLY && pkg !== LEAN_ACTION_CLIENT,
  );
  // Six until 27.6.0: `like` and `likes-badge` import realtime and nothing else, and realtime no
  // longer brings core's barrel with it (`OWN_TITLES_ONLY`). Five from plan 101 wave 9: `summary`
  // reaches the typed action client, as `settings` and `contact-sales` do. Six from plan 101 wave
  // 10, with the posts board, which reaches the typed action client and ui's registry (the runs
  // page's date filter, briefly its own island, is drawn inside the run console).
  // Four from plan 101 slice 11 (K6): `summary` and `contact-sales` reach only the action client,
  // which no longer brings core's barrel (`LEAN_ACTION_CLIENT`).
  expect(expected).toHaveLength(4);
  // The same two faces of the flap, on the module realtime anchors: every island reaching it.
  const realtime = reaching((pkg) => pkg === OWN_TITLES_ONLY);
  expect(realtime).toHaveLength(4);
  expect(realtime).toContain('apps/web/app/posts/[id]/like.island.tsx');
  expect(realtime).toContain('apps/web/app/posts/[id]/likes-badge.island.tsx');
  // Judged on what each island LOADS (`loaded`): grouped islands share the module's one copy.
  const carrying = (build: Built, carries: (code: string) => boolean): string[] =>
    [...build.chunks.values()]
      .filter((chunk) => carries(loaded(chunk, build)))
      .map((chunk) => chunk.file)
      .sort();
  for (const build of [firstBuild, secondBuild]) {
    expect(carrying(build, carriesRegisteredTitles)).toEqual(expected);
    expect(carrying(build, carriesRealtimeTitles)).toEqual(realtime);
  }
});

test('every island is byte-identical to its rebuild in another process', () => {
  expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
  for (const [file, before] of first) {
    const after = second.get(file) as IslandChunk;
    // URL and size first, so a failure names the island instead of printing 100 kB of chunk. The
    // URL is a hash of the bytes, so it moves with them — the code comparison is the claim, and
    // it has no tolerance.
    expect(line(after)).toBe(line(before));
    expect(after.code === before.code, `${line(before)}: same length, different bytes`).toBe(true);
  }
  // And every shared chunk an entry loads: an entry names its chunks by URL, so a chunk that
  // rebuilt to other bytes under the same URL is the same immutable-URL defect one file over.
  expect([...secondBuild.shared.keys()].sort()).toEqual([...firstBuild.shared.keys()].sort());
  for (const [url, code] of firstBuild.shared) {
    expect(secondBuild.shared.get(url) === code, `${url}: different bytes`).toBe(true);
  }
});
