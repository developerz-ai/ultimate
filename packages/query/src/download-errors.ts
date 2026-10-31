/**
 * The four ways a download query is refused, in their own module for `audit-errors.ts`'s reason:
 * the TITLES are registered in `errors.ts` with every code this package owns, and a read that
 * declares no download never constructs one of these.
 */

import { UltimateError } from '@ultimat3/core';

/** `query({ download })` written wrong — refused where it is declared, never on the first request. */
export class QueryDownloadInvalidError extends UltimateError {
  constructor(problem: string) {
    super({
      code: 'X_QUERY_DOWNLOAD_INVALID',
      cause: `a download query cannot be built: ${problem}`,
      fix: 'query({ input, policy, download: { expiresInMs: 300_000, handle: async ({ input, ctx }) => ({ body, contentType, filename }) } }) — a download declares no sql and no row options',
      meta: { problem },
    });
  }
}

/**
 * Rows asked of a query that answers a file. Every rows projection reaches `sql`, and a download
 * stores one that throws this — so `.live()`, `.page()`, `.as()`, `sourceFor`, `explain` and an MCP
 * tool are refused by ONE line rather than each remembering to check.
 */
export class QueryDownloadOnlyError extends UltimateError {
  constructor(query: string) {
    super({
      code: 'X_QUERY_DOWNLOAD_ONLY',
      cause: `"${query}" is a download query: it answers a file at a signed URL, and has no sql to read rows with`,
      fix: 'await recording.url(input)   # a download query mints its signed URL; await recording(input) is the file in-process',
      meta: { query },
    });
  }
}

/** Why a token was refused. Kept in `meta`, never on the wire beyond the code: 403 is the answer. */
export type DownloadTokenProblem = 'malformed' | 'unauthenticated' | 'other-query' | 'other-input';

/**
 * A `_token` this app did not mint for THIS query and THIS input. One code for every reason, so a
 * caller probing tokens learns nothing about which part of a forgery was wrong.
 */
export class QueryDownloadTokenInvalidError extends UltimateError {
  constructor(query: string, problem: DownloadTokenProblem) {
    super({
      code: 'X_QUERY_DOWNLOAD_TOKEN_INVALID',
      cause: `the download URL for "${query}" carries a token this app did not mint for it and this input`,
      fix: `await queryClient<Api['queries']>({ baseUrl }).${query}.url(input)   # a fresh URL; request it unchanged`,
      meta: { query, problem },
    });
  }
}

/** A genuine token past its expiry: the one refusal a fresh mint repairs, so it has its own code. */
export class QueryDownloadTokenExpiredError extends UltimateError {
  constructor(query: string, expiresAt: string) {
    super({
      code: 'X_QUERY_DOWNLOAD_TOKEN_EXPIRED',
      cause: `the download URL for "${query}" expired at ${expiresAt}`,
      fix: `await queryClient<Api['queries']>({ baseUrl }).${query}.url(input)   # right before the request; or raise download.expiresInMs (at most 3_600_000)`,
      meta: { query, expiresAt },
    });
  }
}
