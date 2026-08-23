/**
 * The two request headers the typed client and the HTTP projection both name. Their own module and
 * not `http.ts`'s, because `client.ts` needs exactly these two strings: importing them from there
 * dragged `@ultimat3/http`, `@ultimat3/cache`, `@ultimat3/policy` and the whole `invoke` runtime
 * into every browser bundle that called `rpc()` — 42,204 B against the read client's 11,977 B,
 * measured, which is why two islands in this repo write a bare `fetch` instead of importing one.
 */

/**
 * Matches `HttpConfig.buildIdHeader`; the pipeline reads it into `ctx.clientBuildId` — the
 * CLIENT's claim, never `ctx.buildId`, which is the build this process serves. A mismatch the
 * client sees on the way back is `X_CONTRACT_DRIFT`.
 */
export const BUILD_ID_HEADER = 'x-ultimate-build';

/** RFC 9110's spelling, lower-cased, as `Headers` normalises it. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
