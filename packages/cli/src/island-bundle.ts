// The island chunk table: every `*.island.tsx` in the app compiled as its OWN bundle entry point,
// content-hashed, plus the resolver that turns a page's `src` specifier into the URL its
// `data-x-entry` carries. One entry point per island is axiom 6 made mechanical — the page's graph
// never reaches an island, so a `site/` document stays at 0kb whatever the island imports.

// Bun ships no path API. `posix` does the specifier arithmetic (an app-relative route file is
// POSIX by construction), `join`/`basename` the filesystem side.
import { basename, join, posix, relative, sep } from 'node:path';
import {
  contentHash,
  ISLAND_EXTENSION,
  IslandInvalidError,
  islandModuleId,
} from '@ultimat3/render';
import { IslandBuildFailedError } from './errors';
import { solidProductionPlugin } from './island-solid-production';
import { islandStylesPlugin } from './island-styles';
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
  /** Immutable, content-addressed URL. What `data-x-entry` carries and what a route serves. */
  readonly url: string;
  /** The built JavaScript. Held in memory so `x dev` and the container serve without a disk hop. */
  readonly code: string;
  readonly bytes: number;
}

export interface IslandBundle {
  readonly chunks: readonly IslandChunk[];
  /**
   * The `resolve` a collector is built with, bound to the route file the specifier is relative to.
   * Every island on that page goes through it, so an unbuildable specifier fails the render rather
   * than emitting a `data-x-entry` no browser can import.
   */
  resolverFor(routeFile: string): (src: string) => string;
  /** The chunk a URL names — for serving it, and for naming the island a budget finding blames. */
  chunkAt(url: string): IslandChunk | undefined;
}

/** App-root-relative POSIX paths of every client entry, sorted, so a build is reproducible. */
export async function discoverIslands(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for await (const absolute of new Bun.Glob(ISLAND_GLOB).scan({ cwd: root, absolute: true })) {
    if (absolute.includes('node_modules')) continue;
    files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files.sort();
}

/**
 * One `Bun.build` per island, never one call with N entry points: splitting is off, so each chunk
 * is self-contained and its size is the whole answer to "what does booting this island cost?" —
 * a shared chunk would make the honest number a graph walk, and the budget compares against bytes.
 */
async function buildOne(root: string, file: string): Promise<IslandChunk> {
  // `Bun.build` REJECTS on a failed bundle, it does not answer `success: false` — so the catch is
  // the real path here and the `success` test below is the belt for a future default.
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [join(root, file)],
      target: 'browser',
      format: 'esm',
      splitting: false,
      minify: true,
      // A build with no `plugins` is a build with no JSX transform: `Bun.plugin` installs into the
      // RUNTIME's loader and `Bun.build` walks its own graph, so render's `.tsx` loader never sees
      // an island. The app's tsconfig says `jsx: "preserve"`, which makes the bundler fall back to
      // classic `React.createElement` — emitted into a browser chunk that imports no React, with
      // `success: true` and no log. Every island shipped that way through five majors.
      //
      // The other two close the same shape of failure — a wrong answer `Bun.build` reports as
      // `success: true`: without the second, `target: 'browser'` resolves the `development`
      // export condition and the chunk carries Solid's dev build; without the third, Bun's file
      // loader resolves a `.module.scss` to its asset PATH, so `styles['x']` is `undefined` and
      // every element renders unclassed.
      plugins: [solidJsxPlugin, solidProductionPlugin, islandStylesPlugin],
    });
  } catch (error) {
    throw new IslandBuildFailedError({ file, logs: describeBuildError(error) });
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point');
  if (!built.success || output === undefined) {
    throw new IslandBuildFailedError({
      file,
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  const code = await output.text();
  const moduleId = islandModuleId(basename(file));
  return {
    file,
    moduleId,
    // Hashed with the framework's own `contentHash`, the function that already stamps an ETag and
    // a precache revision — one identity for a byte string, not a third.
    url: `${ISLAND_BASE_PATH}/${moduleId}-${contentHash(code)}.js`,
    code,
    bytes: new TextEncoder().encode(code).byteLength,
  };
}

/**
 * The bundler's own diagnostics, kept verbatim. An `AggregateError` holds one entry per unresolved
 * import or syntax error, and flattening them is what puts the line number in the cause instead of
 * the word "Bundle failed".
 */
function describeBuildError(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map((one: unknown) => String(one)).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
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
  const chunks = await Promise.all(files.map((file) => buildOne(root, file)));
  return islandBundle(chunks);
}

/** Same code as an unbuildable `src`: "this path cannot become a client entry" is one condition. */
function onlyMissing(only: string, discovered: readonly string[]): IslandInvalidError {
  return new IslandInvalidError(
    `buildIslands was asked for ${JSON.stringify(only)} alone, which is not one of the ` +
      `${discovered.length} islands this app has (${discovered.length === 0 ? 'none' : discovered.join(', ')})`,
    `pass only: '<app-root-relative path>${ISLAND_EXTENSION}', exactly as discoverIslands reports it`,
  );
}

export function islandBundle(chunks: readonly IslandChunk[]): IslandBundle {
  const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
  const byUrl = new Map(chunks.map((chunk) => [chunk.url, chunk]));
  return {
    chunks,
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
  };
}

/**
 * The specifier named no file the build could bundle. `X_ISLAND_INVALID` is render's and is
 * borrowed rather than renamed here: "this src cannot become a client entry" is the condition that
 * code already means, and a second name for it is a second thing to look up.
 */
function entryMissing(
  routeFile: string,
  src: string,
  target: string,
  chunks: readonly IslandChunk[],
): IslandInvalidError {
  const known = chunks.map((chunk) => chunk.file);
  return new IslandInvalidError(
    `${routeFile} declares island src ${JSON.stringify(src)}, which resolves to ${target} — a ` +
      `file this build did not bundle (${known.length === 0 ? 'it found no islands at all' : `it found ${known.join(', ')}`})`,
    `x g island ${posix.basename(target, ISLAND_EXTENSION)} --at ${posix.dirname(target)}`,
  );
}

/** Write every chunk under the static export, at the same URL the documents already carry. */
export async function writeIslands(bundle: IslandBundle, out: string): Promise<void> {
  for (const chunk of bundle.chunks) {
    await Bun.write(join(out, chunk.url.slice(1)), chunk.code);
  }
}
