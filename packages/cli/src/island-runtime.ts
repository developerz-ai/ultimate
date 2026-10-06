// The page runtime as ONE chunk beside the islands (#505): realtime's `page-runtime.ts` — the store,
// the socket stack, the query client, core's transport — built once per build, addressed by its
// source graph like any island, and loaded by a realtime island only on a document the page boot
// is absent from. Islands carry thin hooks over it; none carries a copy of it.

// why: Bun ships no path API; the runtime is resolved beside the realtime the islands bundle.
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';
import type { IslandChunk, SharedChunk } from './island-bundle';
import { realSpelling } from './island-duplicates';
import { describeBuildError, graphHash, stableChunk, stripDebugId } from './island-identity';
import { frameworkDedupePlugins } from './island-package-dedupe';
import type { SourcePaths } from './island-sources';
import { sourcesOnDisk } from './island-sources';

/** The runtime, as realtime exports it — resolved from the copy every realtime island bundles. */
const RUNTIME_SPECIFIER = '@ultimat3/realtime/page-runtime';

/** What an island awaits before its first hook: realtime's own, from the same copy. */
const WAIT_SPECIFIER = '@ultimat3/realtime/page-runtime-wait';

/** The virtual entry the runtime is built from, and the module it installs from. */
const ENTRY = 'ultimate:realtime-runtime';
const MODULE = 'ultimate:realtime-runtime-module';
const NAMESPACE = 'ultimate-realtime-runtime';

/**
 * `page-runtime.<identity>.js`. The dot is the point: an island entry is `<moduleId>-<identity>.js`
 * and a module id is `[a-z0-9-]` only (`islandModuleId`), so no island — not even one named
 * `realtime.island.tsx` — can be served at a URL this name could be.
 */
const RUNTIME_CHUNK_FILE = /^page-runtime\.[0-9a-z]+\.js$/;

/** The relative specifier a realtime island's bootstrap `import()`s the runtime chunk by. */
export const RUNTIME_CHUNK_SPECIFIER = /^\.\/page-runtime\.[0-9a-z]+\.js$/;

/** Whether `url` (any base path) is the page runtime's chunk — the one predicate, never a prefix. */
export function isRuntimeChunk(url: string): boolean {
  const slash = url.lastIndexOf('/');
  return slash !== -1 && RUNTIME_CHUNK_FILE.test(url.slice(slash + 1));
}

/** The page runtime a realtime island loads — built once per `buildIslands` call. */
export type Runtimes = (island: string) => Promise<RuntimeChunk>;

/** One runtime chunk: served beside the islands, never a `data-x-entry` of its own. */
export interface RuntimeChunk {
  /**
   * The realtime barrel it was built against — the ONE copy every realtime island of the build
   * bundles its hooks from, or the page object the runtime installs is not the shape they read.
   */
  readonly realtime: string;
  /** What an island's bootstrap awaits the runtime with: `page-runtime-wait.ts`, of that copy. */
  readonly wait: string;
  readonly url: string;
  readonly code: string;
  readonly bytes: number;
  readonly sources: SourcePaths;
}

/**
 * Builds the runtime at most once per build: every realtime island of one `buildIslands` call loads
 * the SAME chunk, whether the islands are built together or one by one. The first island's realtime
 * copy is the build's; another copy at the SAME version is the same code and folds onto it (a
 * Windows `file:` install copies a package where a symlink would fold it). Another VERSION is
 * refused: the first runtime to install wins the page, so that copy's islands would call services
 * of a shape they were not built against.
 */
export function runtimeBuilder(root: string, basePath: string): Runtimes {
  let first: { readonly copy: RealtimeCopy; readonly chunk: Promise<RuntimeChunk> } | undefined;
  return async (island: string): Promise<RuntimeChunk> => {
    // From the island's own directory: the resolution the island itself gets — by its REAL path,
    // the spelling the framework dedupe gives every other `@ultimat3/*` file. Windows' resolver
    // answers a junction's spelling, and Bun keys a module by its path string, so the barrel's own
    // relative imports would ship again beside the realpath ones (`island-duplicates.ts`).
    const copy = await realtimeCopy(
      island,
      realSpelling(Bun.resolveSync('@ultimat3/realtime', dirname(join(root, island)))),
    );
    if (first === undefined) {
      first = { copy, chunk: buildRuntime(root, island, copy.barrel, basePath) };
    } else if (first.copy.version !== copy.version) {
      throw new IslandBuildFailedError({
        file: island,
        logs: `it resolves @ultimat3/realtime ${copy.version} (${copy.dir}) while another island of this build resolves ${first.copy.version} (${first.copy.dir}): one page runs ONE runtime, and @ultimat3/realtime is released in lockstep, so install one version of it across the apps`,
      });
    }
    return first.chunk;
  };
}

interface RealtimeCopy {
  /** The barrel the island resolved. */
  readonly barrel: string;
  /** The package's directory, for the refusal. */
  readonly dir: string;
  readonly version: string;
}

/** The installed package the barrel belongs to: the nearest `package.json` above it. */
async function realtimeCopy(island: string, barrel: string): Promise<RealtimeCopy> {
  for (let dir = dirname(barrel); dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = Bun.file(join(dir, 'package.json'));
    if (!(await manifest.exists())) continue;
    const parsed: unknown = await manifest.json();
    const version =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
    return { barrel, dir, version: typeof version === 'string' ? version : 'an unversioned copy' };
  }
  throw new IslandBuildFailedError({
    file: island,
    logs: `the @ultimat3/realtime it resolves (${barrel}) has no package.json above it, so its version cannot be checked against the build's`,
  });
}

/** A subpath of the realtime at `realtime`, through its `exports` — never a path into its source. */
function exported(island: string, realtime: string, specifier: string): string {
  try {
    return realSpelling(Bun.resolveSync(specifier, dirname(realtime)));
  } catch {
    throw new IslandBuildFailedError({
      file: island,
      logs: `the realtime it resolves (${realtime}) exports no ${specifier}: @ultimat3/realtime and @ultimat3/cli are released in lockstep, so install the same version of both`,
    });
  }
}

async function buildRuntime(
  root: string,
  island: string,
  realtime: string,
  basePath: string,
): Promise<RuntimeChunk> {
  const file = exported(island, realtime, RUNTIME_SPECIFIER);
  const wait = exported(island, realtime, WAIT_SPECIFIER);
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [ENTRY],
      root,
      target: 'browser',
      format: 'esm',
      minify: true,
      plugins: [runtimeEntryPlugin(file), ...frameworkDedupePlugins(root)],
      // `island-bundle.ts`'s reasons, verbatim: only ever built to be shipped, and the map's
      // `sourcesContent` is the one stable identity a minified bundle has.
      define: { 'process.env.NODE_ENV': '"production"' },
      sourcemap: 'external',
    });
  } catch (error) {
    throw new IslandBuildFailedError({ file: island, logs: describeBuildError(error) });
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point');
  const map = built.outputs.find((artifact) => artifact.kind === 'sourcemap');
  if (!built.success || output === undefined || map === undefined) {
    throw new IslandBuildFailedError({
      file: island,
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  const text = await map.text();
  const identity = graphHash(ENTRY, text);
  const url = `${basePath}/page-runtime.${identity}.js`;
  return {
    realtime,
    wait,
    url,
    ...stableChunk(url, identity, stripDebugId(await output.text())),
    sources: await sourcesOnDisk(root, JSON.parse(text)),
  };
}

/**
 * The entry installs the runtime as its whole body; the module is named BARE in that source and
 * resolved here, because the source is part of `sourcesContent` and a machine path in it would give
 * one runtime a different URL in every checkout (the reason `island-realtime.ts` names realtime).
 */
function runtimeEntryPlugin(file: string): BunPlugin {
  return {
    name: 'ultimate-realtime-runtime',
    setup(build) {
      build.onResolve({ filter: /^ultimate:realtime-runtime$/ }, () => ({
        path: 'entry',
        namespace: NAMESPACE,
      }));
      build.onResolve({ filter: /^ultimate:realtime-runtime-module$/ }, () => ({ path: file }));
      build.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({
        contents: `import { installPageRuntime } from '${MODULE}';\ninstallPageRuntime();\n`,
        loader: 'js',
      }));
    },
  };
}

/** Every realtime entry names the runtime among what it loads: a precache and a budget count it. */
export function loadingRuntime(
  chunks: readonly IslandChunk[],
  live: readonly string[],
  runtime: RuntimeChunk | undefined,
): readonly IslandChunk[] {
  if (runtime === undefined) return chunks;
  return chunks.map((chunk) =>
    live.includes(chunk.file)
      ? { ...chunk, imports: [...new Set([...chunk.imports, runtime.url])].sort() }
      : chunk,
  );
}

/** The runtime as the bundle's shared asset — served, written and precached beside the entries. */
export function runtimeShared(
  runtime: RuntimeChunk | undefined,
  live: readonly string[],
): readonly SharedChunk[] {
  if (runtime === undefined) return [];
  const { url, code, bytes, sources } = runtime;
  return [{ url, code, bytes, importers: [...live].sort(), sources }];
}

/**
 * One-island builds as one bundle's two tables: every entry, and each shared asset once by URL with
 * its importers the union — each solo build names the runtime for itself.
 */
export function mergeBuilds(
  builds: readonly {
    readonly chunks: readonly IslandChunk[];
    readonly shared: readonly SharedChunk[];
  }[],
): [readonly IslandChunk[], readonly SharedChunk[]] {
  const byUrl = new Map<string, SharedChunk>();
  for (const one of builds.flatMap((build) => build.shared)) {
    const seen = byUrl.get(one.url);
    byUrl.set(
      one.url,
      seen === undefined
        ? one
        : { ...seen, importers: [...new Set([...seen.importers, ...one.importers])].sort() },
    );
  }
  return [builds.flatMap((build) => build.chunks), [...byUrl.values()]];
}
