// The island chunk table: every `*.island.tsx` in the app compiled as a bundle entry point,
// addressed by a hash of its SOURCE GRAPH (`graphHash` — `Bun.build`'s minified output is not
// byte-deterministic), plus the resolver that turns a page's `src` specifier into the URL its
// `data-x-entry` carries. The page's graph never reaches an island, so a `site/` document stays at
// 0kb whatever the island imports — axiom 6 made mechanical.
//
// Islands every route renders together are ONE split build, sharing what they import as chunks;
// every other island is built alone (`island-groups.ts` has the rule and the measurement).
// `islands: { sharedChunks: true }` makes every island one group: tree shaking across one split
// build keeps what ANY importer uses, so it trades single-island routes' bytes for cache reuse
// across routes (`config-islands.ts` in `@ultimat3/core` has the measurement).

// No page-client bootstrap is prepended (plan 101, decided 2026-09-22): the handle is one
// `globalThis` object created lazily by the first transport call or realtime hook. Measured before
// that decision on `examples/dummy`, a core-importing wrapper cost contact-sales 875 → 8,827 B.
// What IS prepended is the realtime install, and only where the island's graph reaches
// `@ultimat3/realtime` (`island-realtime.ts`); the page runtime it awaits is ONE more output,
// `page-runtime.<identity>.js` beside the entries (`island-runtime.ts`), never inlined into one (#505).

// Bun ships no path API. `posix` does the specifier arithmetic (an app-relative route file is
// POSIX by construction), `join`/`basename` the filesystem side.
import { join, posix, relative, sep } from 'node:path';
import { logger, renderThrowable } from '@ultimat3/core';
import { ISLAND_EXTENSION } from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';
import type { IslandResolve } from './document-options';
import { IslandBuildFailedError } from './errors';
import { boundedMap } from './island-build-pool';
import { environmentDigest, inputDigester, inputFiles } from './island-cache-inputs';
import { refuseDuplicatedModules } from './island-duplicate-refusal';
import type { ModuleIdentityIo } from './island-duplicates';
import { hostIo, memoizedIo } from './island-duplicates';
import { entryMissing, onlyMissing } from './island-entry-missing';
import type { GroupOutput } from './island-group-cache';
import { groupKey, readGroup, sweepOnce, writeGroup } from './island-group-cache';
import { islandGroups } from './island-groups';
import { describeBuildError } from './island-identity';
import { linkOutputs } from './island-link';
import { builtOutputs, entryChunks, ISLAND_BASE_PATH, sharedChunks } from './island-outputs';
import { frameworkDedupePlugins } from './island-package-dedupe';
import {
  islandRealtimePlugin,
  reachesRealtime,
  realtimeIslandEntry,
  realtimeKind,
} from './island-realtime';
import { appPersistsRecords, type IslandRealtime } from './island-realtime-state';
import type { Runtimes } from './island-runtime';
import { loadingRuntime, mergeBuilds, runtimeBuilder, runtimeShared } from './island-runtime';
import { solidDedupePlugin } from './island-solid-dedupe';
import type { SourcePaths } from './island-sources';
import type { IslandStyles } from './island-styles';
import { islandStylesPlugin, stylesheetsOf } from './island-styles';
import { hasPathSegment } from './path-segments';
import { solidJsxPlugin } from './solid-loader';

export { ISLAND_BASE_PATH } from './island-outputs';

/**
 * `shared/` is in and `api/` is out: an island is markup, and an API route has no document to put
 * it in. The glob is the whole discovery rule — a file ships to the browser if and only if its
 * name says so, which is what makes "what ships JS?" answerable without opening a file.
 */
export const ISLAND_GLOB = `apps/*/{site,app,shared}/**/*${ISLAND_EXTENSION}`;

export interface IslandChunk {
  /** App-root-relative POSIX path of the client entry it was built from. */
  readonly file: string;
  /** `islandModuleId` of the filename — the id the document, the budget and a finding all name. */
  readonly moduleId: string;
  /**
   * Immutable, source-addressed URL. What `data-x-entry` carries and what a route serves — stable
   * for as long as the sources, the framework version and the Bun version are. See `graphHash`.
   */
  readonly url: string;
  /** The built JavaScript. Held in memory so `x dev` and the container serve without a disk hop. */
  readonly code: string;
  readonly bytes: number;
  /**
   * Every shared chunk URL this island loads, transitively and sorted — what booting it costs
   * beyond `bytes`, what a precached page must carry with it. Empty for an island sharing nothing.
   */
  readonly imports: readonly string[];
  /** The files on disk it was built from (`island-sources.ts`). Absent on a chunk not built here. */
  readonly sources?: SourcePaths;
  /**
   * Absent unless the island's graph reaches `@ultimat3/realtime`: then whether it has page state
   * to restore or only follows the socket (`island-realtime-state.ts`). On the chunk, so the
   * answer travels with the app it was asked of — through the store, to the document renderer.
   */
  readonly realtime?: IslandRealtime;
}

/** A module two or more islands import, served once beside them. */
export interface SharedChunk {
  /** `/islands/chunk-<identity>.js` — source-addressed like an entry, so `immutable` holds. */
  readonly url: string;
  readonly code: string;
  readonly bytes: number;
  /** The islands (app-root-relative) that load it — for a finding that names what an author edits. */
  readonly importers: readonly string[];
  readonly sources?: SourcePaths;
}

export interface IslandBundle {
  readonly chunks: readonly IslandChunk[];
  /** The shared chunks the entries import — never a `data-x-entry`, always beside one. */
  readonly shared: readonly SharedChunk[];
  /**
   * The `resolve` a collector is built with, bound to the route file the specifier is relative to.
   * Every island on that page goes through it, so an unbuildable specifier fails the render rather
   * than emitting a `data-x-entry` no browser can import.
   */
  resolverFor(routeFile: string): IslandResolve;
  /** Every realtime island of THIS app, by file: what a document's page boot and holds are read from. */
  readonly realtime: ReadonlyMap<string, IslandRealtime>;
  /** The chunk a URL names — for serving it, and for naming the island a budget finding blames. */
  chunkAt(url: string): IslandChunk | undefined;
  /** An entry OR a shared chunk at `url` — what the `/islands/*` route serves. */
  assetAt(url: string): IslandChunk | SharedChunk | undefined;
}

/** App-root-relative POSIX paths of every client entry, sorted, so a build is reproducible. */
export async function discoverIslands(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const absolute of new Bun.Glob(ISLAND_GLOB).scan({ cwd: root, absolute: true })) {
    if (hasPathSegment(absolute, 'node_modules')) continue;
    files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files.sort();
}

/**
 * One `Bun.build` over `files`. With `splitting`, a module two of them import becomes one shared
 * chunk, fetched once by a page that renders both — a page rendering two islands that shared an
 * upload helper downloaded it twice without (one adopter, 2026-09-29: 55.5 kB for ~34 kB of
 * code). Without, `files` is one island and its chunk is self-contained. Either way a route's cost
 * is the graph walk `measureDocumentJs` does off the emitted files.
 */
async function buildAll(
  root: string,
  files: readonly string[],
  splitting: boolean,
  context: BuildContext,
  persists: boolean | undefined,
): Promise<GroupOutput> {
  if (files.length === 0) return { chunks: [], shared: [], inputs: [], stylesheets: [] };
  const { runtimes } = context;
  // Inside the refusal: the realtime probe PARSES the island's graph, and a file that will not
  // parse rejected with a raw `AggregateError: Failed to scan imports` — out of the web boot, with
  // no code, no file and no fix — before `Bun.build` ever ran to raise the one below.
  const realtime = await Promise.all(
    files.map((file) =>
      realtimeKind(root, file, persists).catch((error: unknown) => {
        throw new IslandBuildFailedError({ file, logs: describeBuildError(error) });
      }),
    ),
  );
  // Only an island whose own graph reaches `@ultimat3/realtime` is wrapped (`island-realtime.ts`);
  // every other one is built from its own file, byte for byte what it was.
  const live = files.filter((_, index) => realtime[index] !== undefined);
  const follows = new Set(files.filter((_, index) => realtime[index] === 'follows'));
  const kinds = new Map(files.map((file, index) => [file, realtime[index]]));
  const runtime = live[0] === undefined ? undefined : await runtimes(live[0]);
  const entrypoints = files.map((file, index) =>
    realtime[index] !== undefined ? realtimeIslandEntry(file) : join(root, file),
  );
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints,
      root,
      target: 'browser',
      format: 'esm',
      splitting,
      // `[dir]` keeps two islands sharing a filename apart and maps an output back to its island;
      // a chunk's Bun hash is only a placeholder — `island-link.ts` renames every one.
      naming: { entry: '[dir]/[name].[ext]', chunk: 'chunk-[hash].[ext]' },
      minify: true,
      // A build with no `plugins` is a build with no JSX transform: `Bun.plugin` installs into the
      // RUNTIME's loader and `Bun.build` walks its own graph, so render's `.tsx` loader never sees
      // an island. The app's tsconfig says `jsx: "preserve"`, which makes the bundler fall back to
      // classic `React.createElement` — emitted into a browser chunk that imports no React, with
      // `success: true` and no log. Every island shipped that way through five majors.
      //
      // The second closes the same shape of failure — a wrong answer `Bun.build` reports as
      // `success: true`: without it, Bun's file loader resolves a `.module.scss` to its asset
      // PATH, so `styles['x']` is `undefined` and every element renders unclassed.
      //
      // The dedupe goes FIRST: it answers `solid-js` specifiers before either plugin loads a file,
      // so the `solid-js/web` helpers the JSX transform writes into a symlinked package resolve
      // to the app's one copy. See `island-solid-dedupe.ts` for the measurement. `@ultimat3/*`
      // gets the same rule (`island-package-dedupe.ts`): a nested copy is a second module where no
      // symlink folds it, which is every `file:` install on Windows.
      plugins: [
        ...(runtime === undefined
          ? []
          : [islandRealtimePlugin(root, runtime, follows, live.length === files.length)]),
        solidDedupePlugin(root),
        ...frameworkDedupePlugins(root),
        solidJsxPlugin,
        context.styles,
      ],
      // The third one, and it is a `define` rather than the plugin this used to be: Bun selects
      // the `development`/`production` export condition from the BUILD PROCESS's own `NODE_ENV`,
      // and a defined `process.env.NODE_ENV` overrides it. Measured on 1.4.0, `solid-js` plus
      // `solid-js/web` plus `solid-js/store`: unset → dev build, `test` → dev build, `production`
      // → production build, this line → production build in all three, byte for byte.
      //
      // So without it a chunk built anywhere a container did not run — `x dev`, `x build` on a
      // laptop, `bun test` — ships Solid's development build, and the island's own
      // `process.env.NODE_ENV` reads `"development"` in the file a browser downloads.
      //
      // Pinned rather than inherited, because an island chunk is only ever built to be shipped:
      // `x dev` serves the same chunk the container does, and bytes that depend on the ambient
      // NODE_ENV are a content hash and a byte budget measured on a build nobody ships.
      define: { 'process.env.NODE_ENV': '"production"' },
      // The fourth, and it is asked for its INPUT list rather than its output: `sourcesContent` is
      // the whole module graph each output was built from, which is the only stable identity an
      // output has. See `graphHash`. Measured on 1.4.0 against a 131 kB island: 277ms with it and
      // 276ms without, so the map costs nothing worth naming.
      sourcemap: 'external',
      // The fifth: which inputs each output carries, so one module bundled twice is refused below
      // rather than shipped (`island-duplicates.ts`). Measured on 1.4.2 against examples/dummy's
      // feed island, five interleaved builds each way: 44 ms without, 48 ms with, noise-level.
      metafile: true,
    });
  } catch (error) {
    throw await blame(root, files, error, splitting, context, persists);
  }
  if (!built.success) {
    throw new IslandBuildFailedError({
      file: files.join(', '),
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  if (built.metafile === undefined) {
    throw new IslandBuildFailedError({
      file: files.join(', '),
      logs: 'the bundler returned no metafile',
    });
  }
  await refuseDuplicatedModules(files.join(', '), built.metafile, context.io);
  const sources = new Map<string, SourcePaths>();
  const linked = linkOutputs(await builtOutputs(root, files, built.outputs, sources));
  const chunks = loadingRuntime(entryChunks(files, linked, sources), live, runtime).map(
    (chunk): IslandChunk => {
      const kind = kinds.get(chunk.file);
      return kind === undefined ? chunk : { ...chunk, realtime: kind };
    },
  );
  const shared = sharedChunks(chunks, linked, sources);
  const read = Object.keys(built.metafile.inputs);
  const stylesheets = stylesheetsOf(read);
  // The bundler's inputs, the runtime's, and every Sass partial a sheet `@use`s: a partial moves
  // the sheet's class hashes and is read by the Sass compiler, never by the bundler.
  const partials = context.styles.dependenciesOf(stylesheets);
  const readFiles = [...(await inputFiles(read)), ...(runtime?.inputs ?? []), ...partials];
  return {
    chunks,
    shared: [...shared, ...runtimeShared(runtime, live)],
    inputs: [...new Set(readFiles)].sort(),
    stylesheets,
  };
}

/**
 * Which island a failed build is about. One build over N entries answers one `AggregateError`,
 * and an author owed the file to open would get the whole list. Every island is rebuilt ALONE —
 * only on this path, which is already a refusal — and the first that fails alone is the one named.
 */
async function blame(
  root: string,
  files: readonly string[],
  error: unknown,
  splitting: boolean,
  context: BuildContext,
  persists: boolean | undefined,
): Promise<IslandBuildFailedError> {
  if (files.length > 1) {
    for (const file of files) {
      try {
        await buildAll(root, [file], splitting, context, persists);
      } catch (alone) {
        if (alone instanceof IslandBuildFailedError) return alone;
      }
    }
  }
  return new IslandBuildFailedError({ file: files.join(', '), logs: describeBuildError(error) });
}

/** What every group's build of one `buildIslands` call shares. */
interface BuildContext {
  readonly runtimes: Runtimes;
  /** One styles plugin per call: each sheet compiled once, however many groups load it. */
  readonly styles: IslandStyles;
  /** One realpath per file per call, however many groups' metafiles name it. */
  readonly io: ModuleIdentityIo;
}

export interface BuildIslandsOptions {
  /**
   * Build ONE island, named app-root-relative — the whole option surface. A test that mounts a
   * single island otherwise pays every OTHER island's Babel pass and `Bun.build` on every file,
   * and the reference app is the one that feels it.
   *
   * Optional, and it must stay optional: `buildIslands` is on `@ultimat3/cli`'s public surface and
   * `@ultimat3/testing`'s `IslandBuilder` satisfies it STRUCTURALLY as `(root: string) => …`, which
   * is what keeps the `cli -> testing` edge pointing the one legal way.
   */
  readonly only?: string;
  /**
   * One split build over every island (`app.config.ts`'s `islands.sharedChunks`, off by default),
   * or one build per route group (`island-groups.ts`). Passed, it overrides the app's config — the
   * seam a test asks both questions of one fixture through.
   */
  readonly sharedChunks?: boolean;
  /**
   * Reuse a group's output from `.x/cache/islands/` while every file it read is unchanged
   * (`island-group-cache.ts`) — on by default. `false` is the seam a determinism test builds
   * through: a reused byte string proves nothing about the bundler that emitted it.
   */
  readonly reuse?: boolean;
  /**
   * Whether the app persists records (`appPersistsRecords`), asked only by a group one of whose
   * islands reaches realtime, and once per call. `x dev` builds islands BESIDE the app load
   * (`buildGeneration`), so it passes the answer the registry gives once the load settles; read
   * any earlier it is the empty registry's `undefined`, and every reader islands is held. Absent,
   * the registry is read as it stands: the caller loaded the app first.
   */
  readonly persists?: () => Promise<boolean | undefined>;
}

/** `islands.sharedChunks` off the one loader (`app-config-load.ts`) — `false` with no config file. */
export async function loadSharedChunks(root: string): Promise<boolean> {
  return (await loadAppConfig(root))?.islands.sharedChunks ?? false;
}

/** Build every island in the app. An app with none returns an empty bundle and costs one glob. */
export async function buildIslands(
  root: string,
  options: BuildIslandsOptions = {},
): Promise<IslandBundle> {
  const discovered = await discoverIslands(root);
  const only = options.only;
  const files = only === undefined ? discovered : discovered.filter((file) => file === only);
  // A filter that matches nothing is a typo in the CALLER, never an app with no islands. Answering
  // an empty bundle here would surface two steps later, as a chunk table with no entry for a file
  // the caller can see on disk.
  if (only !== undefined && files.length === 0) throw onlyMissing(only, discovered);
  const context: BuildContext = {
    runtimes: runtimeBuilder(root, ISLAND_BASE_PATH),
    styles: islandStylesPlugin(),
    io: memoizedIo(hostIo()),
  };
  let asked: Promise<boolean | undefined> | undefined;
  const persistsOnce = (): Promise<boolean | undefined> => {
    asked ??= options.persists?.() ?? Promise.resolve(appPersistsRecords());
    return asked;
  };
  // One build per group (`island-groups.ts`): islands every route renders together are one split
  // build; every other island is alone, splitting off, self-contained but for the page runtime —
  // the ONE file every realtime island loads, counted once however many load it.
  // `islands.sharedChunks` is the one group of every island, split as it always was.
  const everyIsland = files.length > 0 && (options.sharedChunks ?? (await loadSharedChunks(root)));
  const groups = everyIsland ? [files] : files.length === 0 ? [] : await islandGroups(root, files);
  const reuse = options.reuse ?? true;
  const cache = {
    environment: reuse ? await environmentDigest(root) : '',
    digestOf: inputDigester(),
    warned: false,
  };
  const build = async (group: readonly string[]): Promise<GroupBuild> => {
    const splitting = everyIsland || group.length > 1;
    // The registry's answer only where it changes the bytes: a group with no realtime island
    // builds at once, while `x dev`'s app load is still running beside it. A probe that cannot
    // parse reads as reaching, so `buildAll` raises the island's own coded refusal.
    const reaches = await Promise.all(
      group.map((file) => reachesRealtime(root, file).catch(() => true)),
    );
    const persists = reaches.includes(true) ? await persistsOnce() : undefined;
    if (!reuse) return buildAll(root, group, splitting, context, persists);
    const key = groupKey({ group, splitting, environment: cache.environment, persists });
    const hit = await readGroup(root, key, cache.digestOf);
    if (hit !== undefined) return hit;
    // The wall clock as the filesystem stamps an mtime — never `Date.now()`, which a test may freeze.
    const startedAt = performance.timeOrigin + performance.now();
    const output = await buildAll(root, group, splitting, context, persists);
    // Best effort: a read-only tree (a pod whose image skipped `x build --target prebuilt`) still
    // serves what it just built — a cache it cannot write is a slower next boot, never a failed one.
    await writeGroup(root, key, output, startedAt, cache.digestOf).catch((error: unknown) => {
      if (!cache.warned) logger.warn(`island cache not written: ${renderThrowable(error)}`);
      cache.warned = true;
    });
    return output;
  };
  if (reuse) await sweepOnce(root);
  const width = navigator.hardwareConcurrency;
  return islandBundle(...mergeBuilds(await boundedMap(groups, width, build)));
}

type GroupBuild = Pick<GroupOutput, 'chunks' | 'shared'>;

export function islandBundle(
  chunks: readonly IslandChunk[],
  shared: readonly SharedChunk[] = [],
): IslandBundle {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const byUrl = new Map(chunks.map((chunk) => [chunk.url, chunk]));
  const sharedByUrl = new Map(shared.map((chunk) => [chunk.url, chunk]));
  const realtime = new Map<string, IslandRealtime>();
  for (const chunk of chunks)
    if (chunk.realtime !== undefined) realtime.set(chunk.file, chunk.realtime);
  return {
    chunks,
    shared,
    realtime,
    resolverFor(routeFile: string): IslandResolve {
      const dir = posix.dirname(routeFile);
      const resolve = (src: string): string => {
        const target = posix.normalize(posix.join(dir, src));
        const chunk = byFile.get(target);
        if (chunk === undefined) throw entryMissing(routeFile, src, target, chunks);
        return chunk.url;
      };
      // What the document preloads for each island it rendered (`route-islands-preload.ts`).
      const importsOf = (url: string): readonly string[] => byUrl.get(url)?.imports ?? [];
      return Object.assign(resolve, { importsOf });
    },
    chunkAt: (url: string): IslandChunk | undefined => byUrl.get(url),
    assetAt: (url: string): IslandChunk | SharedChunk | undefined =>
      byUrl.get(url) ?? sharedByUrl.get(url),
  };
}

/** Write every chunk under the static export, at the same URL the documents already carry. */
export async function writeIslands(bundle: IslandBundle, out: string): Promise<void> {
  for (const chunk of [...bundle.chunks, ...bundle.shared]) {
    await Bun.write(join(out, chunk.url.slice(1)), chunk.code);
  }
}
