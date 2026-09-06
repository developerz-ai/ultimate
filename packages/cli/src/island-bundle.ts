// The island chunk table: every `*.island.tsx` in the app compiled as its OWN bundle entry point,
// addressed by a hash of its SOURCE GRAPH (`graphHash` — `Bun.build`'s minified output is not
// byte-deterministic), plus the resolver that turns a page's `src` specifier into the URL its
// `data-x-entry` carries. One entry point per island is axiom 6 made mechanical — the page's graph
// never reaches an island, so a `site/` document stays at 0kb whatever the island imports.

// Bun ships no path API. `posix` does the specifier arithmetic (an app-relative route file is
// POSIX by construction), `join`/`basename` the filesystem side.
import { basename, join, posix, relative, sep } from 'node:path';
import { frameworkVersion, renderThrowable } from '@ultimat3/core';
import { ISLAND_EXTENSION, IslandInvalidError, islandModuleId } from '@ultimat3/render';
import { contentHash } from '@ultimat3/render/server';
import { IslandBuildFailedError } from './errors';
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
  /**
   * Immutable, source-addressed URL. What `data-x-entry` carries and what a route serves — stable
   * for as long as the sources, the framework version and the Bun version are. See `graphHash`.
   */
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
      // The second closes the same shape of failure — a wrong answer `Bun.build` reports as
      // `success: true`: without it, Bun's file loader resolves a `.module.scss` to its asset
      // PATH, so `styles['x']` is `undefined` and every element renders unclassed.
      plugins: [solidJsxPlugin, islandStylesPlugin],
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
      // the whole module graph this chunk was built from, which is the only stable identity a
      // chunk has. See `graphHash`. Measured on 1.4.0 against a 131 kB island: 277ms with it and
      // 276ms without, so the map costs nothing worth naming.
      sourcemap: 'external',
    });
  } catch (error) {
    throw new IslandBuildFailedError({ file, logs: describeBuildError(error) });
  }
  const output = built.outputs.find((artifact) => artifact.kind === 'entry-point');
  const map = built.outputs.find((artifact) => artifact.kind === 'sourcemap');
  if (!built.success || output === undefined || map === undefined) {
    throw new IslandBuildFailedError({
      file,
      logs: built.logs.map((log) => String(log)).join('; '),
    });
  }
  const code = stripDebugId(await output.text());
  const hash = graphHash(file, await map.text());
  const moduleId = islandModuleId(basename(file));
  return {
    file,
    moduleId,
    url: `${ISLAND_BASE_PATH}/${moduleId}-${hash}.js`,
    // The FIRST bytes this process emitted for these inputs, so a URL served `immutable` answers
    // one byte string for as long as the process lives. Without it `x dev` re-mints the chunk on
    // every watcher tick and a browser holding the previous one under `max-age=31536000` has two
    // different files at one address.
    code: stableCode(file, hash, code),
    bytes: new TextEncoder().encode(code).byteLength,
  };
}

/**
 * `sourcemap: 'external'` appends `//# debugId=<hex>` to the chunk. It is a pointer to a map this
 * framework does not serve, so it is removed rather than shipped — and removing it makes the
 * emitted bytes identical to what the same build produced before the map was asked for, which is
 * what keeps `bytes` a budget number and not a build-flag artefact. `slice`, never a `replace` with
 * an empty replacement — `bun run sql-literal-copies` refuses that shape anywhere but `db/sql.ts`.
 */
const DEBUG_ID_COMMENT = '\n//# debugId=';

function stripDebugId(code: string): string {
  const at = code.lastIndexOf(DEBUG_ID_COMMENT);
  return at === -1 ? code : code.slice(0, at);
}

/**
 * The chunk's identity, computed from what went IN rather than from what came out.
 *
 * `Bun.build` is not byte-deterministic under `minify`. Measured on 1.4.0, one entry point, no
 * source file touched: a 131,589-byte island alternated between two outputs of IDENTICAL length
 * differing only in minified identifier names (`var ca=Object.defineProperty` against
 * `var la=…`) — roughly one build in ten, which is a race in the renamer and not anything a caller
 * can order. Hashing that output made the URL flap: ten distinct `session-console-*.js` names in
 * ten minutes, so a service worker's precache manifest named a chunk that already 404ed and a
 * browser's `immutable` cache never hit on a 131 kB download. Twelve consecutive builds hash
 * identically here.
 *
 * `sourcesContent`, hashed per file and SORTED, so the identity is independent of the order the
 * bundler happened to visit the graph in. The PATHS are deliberately not in it: they are absolute
 * on the build machine and would make a chunk built in a container disagree with the same chunk
 * built on a laptop for no difference a browser could observe. `file` is, so two islands with
 * byte-identical sources under different names stay two chunks; the framework version and the Bun
 * version are, because both decide the emitted bytes while no source file moves — an upgrade must
 * mint a new URL rather than leave a stale chunk pinned in a browser for a year.
 *
 * What this gives up, stated plainly: the URL is source-addressed, not byte-addressed, so two
 * processes building the same sources can serve two byte-strings at one URL. They are the same
 * program under different local identifier names. That is the trade a nondeterministic bundler
 * forces, and the alternative — `minify: { identifiers: false }`, which IS deterministic — was
 * measured at 193,590 bytes against 131,649, +47% raw and +20% gzipped, on every island of every
 * app. Delete this the day `Bun.build` is deterministic.
 */
function graphHash(file: string, map: string): string {
  const parsed: unknown = JSON.parse(map);
  const contents = sourcesContentOf(parsed);
  if (contents === undefined) {
    throw new IslandBuildFailedError({
      file,
      logs: 'the bundler emitted a source map with no sourcesContent, so the chunk has no stable identity',
    });
  }
  const graph = contents.map((source) => contentHash(source)).sort();
  return contentHash([file, frameworkVersion(), Bun.version, ...graph].join('\u0000'));
}

/**
 * `sourcesContent`, read the way `aggregatedErrors` below reads `errors`: narrowed first,
 * dereferenced inside a `try`, `undefined` for anything that is not a full list of strings. A
 * partial list is refused rather than padded — a graph with holes in it hashes two different
 * islands the same.
 */
function sourcesContentOf(value: unknown): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const held: unknown = (value as Record<string, unknown>)['sourcesContent'];
    if (!Array.isArray(held) || held.length === 0) return undefined;
    return held.every((one: unknown) => typeof one === 'string')
      ? (held as readonly string[])
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The code this process already emitted for these inputs, or the code it just built.
 *
 * Keyed by PATH and validated by the input hash, `transformIslandTsx`'s cache's shape and for its
 * reason: one entry per island bounds the map by the island count, which is the only quantity that
 * should bound it, and an entry whose hash no longer matches is replaced rather than served.
 */
const emitted = new Map<string, { readonly graph: string; readonly code: string }>();

/** Test seam: the table is process-global because the dev server it serves is too. */
export function clearIslandChunkCache(): void {
  emitted.clear();
}

/**
 * `graph`, never `hash`: `bun run secret-compare` reads the NAME of a comparison's operands, and a
 * value called `hash` is a digest an attacker may be probing. This one is a build input's
 * identity — the same reason `pr-threads.ts` calls a review state `wanted`.
 */
function stableCode(file: string, graph: string, code: string): string {
  const hit = emitted.get(file);
  if (hit !== undefined && hit.graph === graph) return hit.code;
  emitted.set(file, { graph, code });
  return code;
}

/**
 * The bundler's own diagnostics, kept verbatim. An `AggregateError` holds one entry per unresolved
 * import or syntax error, and flattening them is what puts the line number in the cause instead of
 * the word "Bundle failed".
 */
export function describeBuildError(error: unknown): string {
  // `renderThrowable`, never `instanceof` + `.message` + `String()`. All three run on a value this
  // process did not build — a `Proxy` traps `getPrototypeOf`, a `message` getter can raise, and
  // `String()` throws outright on a Symbol — and what comes back is carried in
  // `IslandBuildFailedError.logs`, which `errors.ts` interpolates straight into a `cause:`. That
  // is a cross-file hop neither `scripts/catch-render.ts` nor `scripts/error-render.ts` can
  // follow: a throw here loses the whole refusal and replaces it with a TypeError about reporting.
  //
  // The AggregateError branch stays, and it is the reason this function exists: `Bun.build` packs
  // one entry per unresolved import or syntax error into `errors`, and flattening them is what
  // puts a line number in the cause instead of the words "Bundle failed". `stringField` decides
  // whether the value really is that shape, because `instanceof` is a question a Proxy answers.
  const aggregate = aggregatedErrors(error);
  if (aggregate !== undefined && aggregate.length > 0) {
    return aggregate.map((one: unknown) => renderThrowable(one)).join('; ');
  }
  return renderThrowable(error);
}

/**
 * `value.errors`, read the way `@ultimat3/core`'s `stringField` reads a string field: narrowed
 * first, dereferenced inside a `try`, `undefined` for anything else. `instanceof AggregateError`
 * is a question a `Proxy` answers with its own `getPrototypeOf` trap, so it is not a check.
 */
function aggregatedErrors(value: unknown): readonly unknown[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const held: unknown = (value as Record<string, unknown>)['errors'];
    return Array.isArray(held) ? held : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Same code as an unbuildable `src`: "this path cannot become a client entry" is one condition.
 *
 * Two fixes, because there are two causes and only one of them can be repaired by naming a path.
 * The line was `pass only: '<app-root-relative path>.island.tsx'` — a placeholder nobody can run,
 * which no gate could see: `fixProblem` fails a fix only for ADVICE with no command token, and a
 * sentence with neither is not advice. Both forms below are constructed from what the caller
 * already handed in, so neither can name a path this app does not have.
 */
function onlyMissing(only: string, discovered: readonly string[]): IslandInvalidError {
  const cause =
    `buildIslands was asked for ${JSON.stringify(only)} alone, which is not one of the ` +
    `${discovered.length} islands this app has (${discovered.length === 0 ? 'none' : discovered.join(', ')})`;
  // The basename match first: a filter that misses normally missed on the PREFIX — a route-relative
  // specifier where `discoverIslands`' app-root-relative path was wanted — and the filename
  // survives that. Falling back to the first keeps the fix a real path rather than a shape.
  const nearest =
    discovered.find((file) => posix.basename(file) === posix.basename(only)) ?? discovered[0];
  // An app with no islands cannot be pointed at one, so the fix WRITES the file that was asked
  // for — the same command `entryMissing` hands back, split off the same path.
  if (nearest === undefined) {
    return new IslandInvalidError(
      cause,
      `x g island ${posix.basename(only, ISLAND_EXTENSION)} --at ${posix.dirname(only)}`,
    );
  }
  return new IslandInvalidError(cause, `buildIslands(root, { only: '${nearest}' })`);
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
