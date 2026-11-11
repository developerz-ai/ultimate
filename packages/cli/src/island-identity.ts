// What an island output is, beyond its bytes: the source map's inputs (`sourcesContentOf`), the
// per-process pin that keeps one URL one byte string (`stableChunk`), and the bundler-diagnostic
// flattening every island refusal carries. Split from `island-bundle.ts`, which builds.

import { renderThrowable } from '@ultimat3/core';

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

// An island output's URL is `contentHash` of the bytes served under it (`island-link.ts`), never of
// its sources. Both were tried:
//
// - Output-addressed, then flapped: `Bun.build` under `minify` was not byte-deterministic before
//   1.4.1 (oven-sh/bun#40657) — ten `session-console-*.js` names in ten minutes on 1.4.0 — so a
//   precache manifest named a chunk that already 404ed (19.2.0). Fixed upstream; on 1.4.2, 192
//   contended build pairs of `examples/dummy`'s islands emitted one byte string per island (#354),
//   and `island-determinism.test.ts` holds it.
// - Source-addressed, then served the wrong program (#1075): the minifier names a shared chunk's
//   exports by how often the WHOLE build uses them, so editing one entry swapped two export
//   names in a chunk whose sources had not moved. One URL, two byte strings, `immutable` — and a CDN handed
//   the next build's islands the action client where they imported the query client.
//
// A flapping name costs a cache miss; a stuck one ships a broken page. So the name is the bytes.

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
 * The code this process already emitted under this identity, or the code it just built. Every
 * caller's identity is now `contentHash(code)`, so a hit is these bytes again: the table pins
 * nothing the name does not, and `bytes` is measured here, once, on what is served.
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
 * value called `hash` is a digest an attacker may be probing. This one is a build output's
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
