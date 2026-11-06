// Single responsibility: the declaration-time screen for a read's freshness options — `etag`, the
// time bound and the null's lease. Refused on the line that wrote them, never on the first request:
// a value wrong for one call of a query is wrong for every call of it.

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import { QueryCacheTtlInvalidError } from './errors';

export class QueryEtagInvalidError extends UltimateError {
  constructor(why: 'download' | 'live') {
    super({
      code: 'X_QUERY_ETAG_INVALID',
      cause:
        why === 'download'
          ? 'query({ download, etag: true }) — a download answers its own ETag on the file it serves'
          : 'query({ live: true, etag: true }) — a live read is revalidated by its cursor, not a validator',
      fix: "query({ input, policy, sql })  # the declaration the cause names, with etag: true removed; a live read's cursor is its validator",
      meta: { why },
    });
  }
}

export class QueryTimeoutInvalidError extends UltimateError {
  constructor(value: unknown, why: string) {
    super({
      code: 'X_QUERY_TIMEOUT_INVALID',
      cause: `query({ timeoutMs: ${renderCauseValue(value)} }) — ${why}`,
      fix: 'query({ timeoutMs: 500 })  # a whole number of ms under the role bound, read with: psql "$DATABASE_URL" -c "show statement_timeout" — or drop timeoutMs',
    });
  }
}

export interface FreshnessDecl {
  readonly etag?: unknown;
  readonly live?: boolean | undefined;
  readonly timeoutMs?: unknown;
  readonly cache?: { readonly ttlMs?: number; readonly negativeTtlMs?: number } | undefined;
}

/** A lease every tier refuses, refused here with the field that wrote it. */
function assertLease(value: number | undefined, field: 'ttlMs' | 'negativeTtlMs'): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) throw new QueryCacheTtlInvalidError(value, field);
}

/** Rows reads. `download` reads go through `assertDownloadFreshness` instead. */
export function assertFreshness(def: FreshnessDecl): void {
  assertLease(def.cache?.ttlMs, 'ttlMs');
  assertLease(def.cache?.negativeTtlMs, 'negativeTtlMs');
  if (def.etag === true && def.live === true) throw new QueryEtagInvalidError('live');
  const timeoutMs = def.timeoutMs;
  if (timeoutMs === undefined) return;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new QueryTimeoutInvalidError(timeoutMs, 'a bound is a whole number of ms above 0');
  }
}

/** A download has its own validators and no `sql` to bound: both options are refused beside it. */
export function assertDownloadFreshness(def: object): void {
  if ('etag' in def && def.etag !== undefined) throw new QueryEtagInvalidError('download');
  if ('timeoutMs' in def && def.timeoutMs !== undefined) {
    throw new QueryTimeoutInvalidError(def.timeoutMs, 'a download read runs no sql to bound');
  }
}
