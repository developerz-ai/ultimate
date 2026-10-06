// The island chunk table: every `*.island.tsx` in the app compiled as its OWN bundle entry point,
// addressed by a hash of its SOURCE GRAPH (`graphHash` — `Bun.build`'s minified output is not
// byte-deterministic), plus the resolver that turns a page's `src` specifier into the URL its
// `data-x-entry` carries. One entry point per island is axiom 6 made mechanical — the page's graph
// never reaches an island, so a `site/` document stays at 0kb whatever the island imports.
//
// `islands: { sharedChunks: true }` builds every island in ONE split build instead, so a module two
// islands import is one shared chunk a browser fetches once (`island-link.ts` names and links the
// outputs). Measured on a fixture of two islands sharing a 20 kB module, As of 2026-09-29: 41,926 B
// charged to the page with both off, 21,996 B on; the page with one of them 21,837 → 21,894 B. Off
// by default: tree shaking across one split build keeps what ANY importer uses (`config-islands.ts`
// in `@ultimat3/core` has the measurement that decided it).
//
// No page-client bootstrap is prepended (plan 101, decided 2026-09-22): the handle is one
// `globalThis` object created lazily by the first transport call or realtime hook. Measured before
// that decision on `examples/dummy`, a core-importing wrapper cost contact-sales 875 → 8,827 B.
// What IS prepended is the realtime install, and only where the island's graph reaches
// `@ultimat3/realtime` (`island-realtime.ts`); the page runtime it awaits is ONE more output,
// `page-runtime.<identity>.js` beside the entries (`island-runtime.ts`), never inlined into one (#505).

// Bun ships no path API. `posix` does the specifier arithmetic (an app-relative route file is
// POSIX by construction), `join`/`basename` the filesystem side.
import { basename, join, posix, relative, sep } from 'node:path';
import { ISLAND_EXTENSION, islandModuleId } from '@ultimat3/render';
import { loadAppConfig } from './app-config-load';
import { IslandBuildFailedError } from './errors';
import { refuseDuplicatedModules } from './island-duplicate-refusal';
import { entryMissing, onlyMissing } from './island-entry-missing';
import { describeBuildError, sourcesContentOf, stableChunk, stripDebugId } from './island-identity';
import type { BuiltOutput, LinkedFile } from './island-link';
import { linkOutputs, sharedChunkName } from './island-link';
import { frameworkDedupePlugins } from './island-package-dedupe';
import {
  islandRealtimePlugin,
  REALTIME_ISLAND_ENTRY,
  reachesRealtime,
  realtimeIslandEntry,
} from './island-realtime';
import type { Runtimes } from './island-runtime';
import { loadingRuntime, mergeBuilds, runtimeBuilder, runtimeShared } from './island-runtime';
import { solidDedupePlugin } from './island-solid-dedupe';
import type { SourcePaths } from './island-sources';
import { sourcesOnDisk } from './island-sources';
import { islandStylesPlugin } from './island-styles';
import { hasPathSegment } from './path-segments';
import { solidJsxPlugin } from './solid-loader';

/**
 * Where a chunk is served from, in `x dev`, in the container and in a static export — one base
 * path, because the URL is minted by one resolver and baked into the document. Sits beside
 * `ICON_BASE_PATH` and `MEDIA_BASE_PATH`, deliberately outside the dev-only `/_x` namespace.
 */
export const ISLAND_BASE_PATH = '/islands';

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
  resolverFor(routeFile: string): (src: string) => string;
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
 * upload helper downloaded it twice without (notificado.co, 2026-09-29: 55.5 kB for ~34 kB of
 * code). Without, `files` is one island and its chunk is self-contained. Either way a route's cost
 * is the graph walk `measureDocumentJs` does off the emitted files.
 */
async function buildAll(
  root: string,
  files: readonly string[],
  splitting: boolean,
  runtimes: Runtimes,
): Promise<{ readonly chunks: readonly IslandChunk[]; readonly shared: readonly SharedChunk[] }> {
  if (files.length === 0) return { chunks: [], shared: [] };
  // Inside the refusal: the realtime probe PARSES the island's graph, and a file that will not
  // parse rejected with a raw `AggregateError: Failed to scan imports` — out of the web boot, with
  // no code, no file and no fix — before `Bun.build` ever ran to raise the one below.
  const realtime = await Promise.all(
    files.map((file) =>
      reachesRealtime(root, file).catch((error: unknown) => {
        throw new IslandBuildFailedError({ file, logs: describeBuildError(error) });
      }),
    ),
  );
  // Only an island whose own graph reaches `@ultimat3/realtime` is wrapped (`island-realtime.ts`);
  // every other one is built from its own file, byte for byte what it was.
  const live = files.filter((_, index) => realtime[index] === true);
  const runtime = live[0] === undefined ? undefined : await runtimes(live[0]);
  const entrypoints = files.map((file, index) =>
    realtime[index] === true ? realtimeIslandEntry(file) : join(root, file),
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
        ...(runtime === undefined ? [] : [islandRealtimePlugin(root, runtime)]),
        solidDedupePlugin(root),
        ...frameworkDedupePlugins(root),
        solidJsxPlugin,
        islandStylesPlugin,
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
    throw await blame(root, files, error, splitting, runtimes);
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
  await refuseDuplicatedModules(files.join(', '), built.metafile);
  const sources = new Map<string, SourcePaths>();
  const linked = linkOutputs(await builtOutputs(root, files, built.outputs, sources));
  const chunks = loadingRuntime(entryChunks(files, linked, sources), live, runtime);
  const shared = sharedChunks(chunks, linked, sources);
  return { chunks, shared: [...shared, ...runtimeShared(runtime, live)] };
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
  runtimes: Runtimes,
): Promise<IslandBuildFailedError> {
  if (files.length > 1) {
    for (const file of files) {
      try {
        await buildAll(root, [file], splitting, runtimes);
      } catch (alone) {
        if (alone instanceof IslandBuildFailedError) return alone;
      }
    }
  }
  return new IslandBuildFailedError({ file: files.join(', '), logs: describeBuildError(error) });
}

/**
 * Bun's `./a/b.island.js` → `a/b.island.js`. A realtime wrapper's output is named after its
 * VIRTUAL entry, which Bun places relative to the cwd behind `_.._/` segments — so everything up to
 * and including the prefix goes, leaving the island's own spelling.
 */
const outputKey = (path: string): string => {
  const bare = path.startsWith('./') ? path.slice(2) : path;
  const at = bare.indexOf(REALTIME_ISLAND_ENTRY);
  return at === -1 ? bare : bare.slice(at + REALTIME_ISLAND_ENTRY.length);
};

const withoutExtension = (file: string): string =>
  file.slice(0, file.length - posix.extname(file).length);

/** Every code output paired with its source map's inputs and, for an entry, its island. */
async function builtOutputs(
  root: string,
  files: readonly string[],
  artifacts: readonly Bun.BuildArtifact[],
  sourcePaths: Map<string, SourcePaths>,
): Promise<readonly BuiltOutput[]> {
  const byStem = new Map(files.map((file) => [withoutExtension(file), file]));
  const maps = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.kind === 'sourcemap') maps.set(artifact.path, await artifact.text());
  }
  const outputs: BuiltOutput[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind !== 'entry-point' && artifact.kind !== 'chunk') continue;
    const key = outputKey(artifact.path);
    const file = artifact.kind === 'entry-point' ? byStem.get(withoutExtension(key)) : undefined;
    const map = maps.get(`${artifact.path}.map`);
    const parsed: unknown = map === undefined ? undefined : JSON.parse(map);
    const sources = parsed === undefined ? undefined : sourcesContentOf(parsed, true);
    sourcePaths.set(key, await sourcesOnDisk(root, parsed));
    if (sources === undefined || (artifact.kind === 'entry-point' && file === undefined)) {
      throw new IslandBuildFailedError({
        file: file ?? key,
        logs: `the bundler emitted ${key} with no source map or no island behind it, so the output has no stable identity`,
      });
    }
    outputs.push({
      path: key,
      ...(file === undefined ? {} : { file }),
      code: stripDebugId(await artifact.text()),
      sources,
    });
  }
  return outputs;
}

/** The linked outputs, as the chunk table: the entries in `files` order, their chunks attached. */
function entryChunks(
  files: readonly string[],
  linked: readonly LinkedFile[],
  sources: ReadonlyMap<string, SourcePaths>,
): readonly IslandChunk[] {
  const shared = new Map(
    linked
      .filter((one) => one.file === undefined)
      .map((one) => [sharedChunkName(one.identity), one]),
  );
  const closure = (start: readonly string[]): readonly string[] => {
    const seen = new Set<string>();
    const walk = (names: readonly string[]): void => {
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        walk(shared.get(name)?.imports ?? []);
      }
    };
    walk(start);
    return [...seen].sort().map((name) => `${ISLAND_BASE_PATH}/${name}`);
  };
  const chunks: IslandChunk[] = [];
  for (const file of files) {
    const entry = linked.find((one) => one.file === file);
    if (entry === undefined) {
      throw new IslandBuildFailedError({ file, logs: 'the bundler emitted no entry point for it' });
    }
    const moduleId = islandModuleId(basename(file));
    chunks.push({
      file,
      moduleId,
      url: `${ISLAND_BASE_PATH}/${moduleId}-${entry.identity}.js`,
      // The FIRST bytes this process emitted for these inputs, so a URL served `immutable` answers
      // one byte string for as long as the process lives. Without it `x dev` re-mints the chunk on
      // every watcher tick and a browser holding the previous one under `max-age=31536000` has two
      // different files at one address. `bytes` is measured on THAT code, never on this build's.
      ...stableChunk(file, entry.identity, entry.code),
      imports: closure(entry.imports),
      sources: sources.get(entry.path) ?? [],
    });
  }
  return chunks;
}

/** Every shared chunk the entries load, pinned the same way, with the islands that load it. */
function sharedChunks(
  chunks: readonly IslandChunk[],
  linked: readonly LinkedFile[],
  sources: ReadonlyMap<string, SourcePaths>,
): readonly SharedChunk[] {
  const out: SharedChunk[] = [];
  for (const one of linked) {
    if (one.file !== undefined) continue;
    const url = `${ISLAND_BASE_PATH}/${sharedChunkName(one.identity)}`;
    out.push({
      url,
      ...stableChunk(url, one.identity, one.code),
      importers: chunks
        .filter((chunk) => chunk.imports.includes(url))
        .map((chunk) => chunk.file)
        .sort(),
      sources: sources.get(one.path) ?? [],
    });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
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
   * or one self-contained build per island. Passed, it overrides the app's config — the seam a test
   * asks both questions of one fixture through.
   */
  readonly sharedChunks?: boolean;
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
  const runtimes = runtimeBuilder(root, ISLAND_BASE_PATH);
  if (options.sharedChunks ?? (await loadSharedChunks(root))) {
    const built = await buildAll(root, files, true, runtimes);
    return islandBundle(built.chunks, built.shared);
  }
  // One build per island, splitting off: each chunk is self-contained but for the page runtime,
  // the ONE file beside it every realtime island loads, counted once however many load it.
  const solo = await Promise.all(files.map((file) => buildAll(root, [file], false, runtimes)));
  return islandBundle(...mergeBuilds(solo));
}

export function islandBundle(
  chunks: readonly IslandChunk[],
  shared: readonly SharedChunk[] = [],
): IslandBundle {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const byUrl = new Map(chunks.map((chunk) => [chunk.url, chunk]));
  const sharedByUrl = new Map(shared.map((chunk) => [chunk.url, chunk]));
  return {
    chunks,
    shared,
    resolverFor(routeFile: string): (src: string) => string {
      const dir = posix.dirname(routeFile);
      return (src: string): string => {
        const target = posix.normalize(posix.join(dir, src));
        const chunk = byFile.get(target);
        if (chunk === undefined) throw entryMissing(routeFile, src, target, chunks);
        return chunk.url;
      };
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
