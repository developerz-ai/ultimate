// An island output's identity and the one byte string served under it: the source-graph hash
// that names a URL (`graphHash`), the per-process pin that keeps one URL one byte string
// (`stableChunk`), and the bundler-diagnostic flattening every island refusal carries. Split from
// `island-bundle.ts`, which builds; `worker-bundle.ts` names its chunks by the same rules.

import { frameworkVersion, renderThrowable } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import { IslandBuildFailedError } from './errors';

/**
 * `sourcemap: 'external'` appends `//# debugId=<hex>` to the chunk. It is a pointer to a map this
 * framework does not serve, so it is removed rather than shipped — and removing it makes the
 * emitted bytes identical to what the same build produced before the map was asked for, which is
 * what keeps `bytes` a budget number and not a build-flag artefact. `slice`, never a `replace` with
 * an empty replacement — `bun run sql-literal-copies` refuses that shape anywhere but `db/sql.ts`.
 */
const DEBUG_ID_COMMENT = '\n//# debugId=';

export function stripDebugId(code: string): string {
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
export function graphHash(file: string, map: string): string {
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
export function sourcesContentOf(
  value: unknown,
  allowEmpty = false,
): readonly string[] | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const held: unknown = (value as Record<string, unknown>)['sourcesContent'];
    // Empty is admitted only for a split build's output, where a chunk of bundler runtime helpers
    // has no source file behind it and `island-link.ts` names it by its code instead.
    if (!Array.isArray(held) || (held.length === 0 && !allowEmpty)) return undefined;
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
export function stableChunk(
  file: string,
  graph: string,
  code: string,
): { readonly code: string; readonly bytes: number } {
  const hit = emitted.get(file);
  const served = hit !== undefined && hit.graph === graph ? hit.code : code;
  if (served === code) emitted.set(file, { graph, code });
  // Measured on the code that is SERVED. It was measured on this build's output, which under a
  // minifier that renames differently between builds is a second size for one URL in one process
  // — and a budget weighed on bytes no browser receives.
  return { code: served, bytes: new TextEncoder().encode(served).byteLength };
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
