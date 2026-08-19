// The claim lease's one definition and its one normalisation. Both outbox stores read it, because
// a lease the memory store defaults and the pg store validates is two answers to "how long is a
// claim mine for" — and the shorter of the two is a row published twice.

import { assert } from '@ultimat3/core';

/**
 * How long a claimed row stays its claimant's. Long enough that no healthy pass loses a batch it
 * is still publishing, short enough that a relay killed mid-batch does not strand one for minutes.
 */
export const DEFAULT_OUTBOX_CLAIM_LEASE_MS = 30_000;

/**
 * Refused where it is written, the way `concurrency: 0` and `stepTimeout: 0` are. A lease of `0`
 * expires before `claim()` resolves, so every relay reclaims every row on every tick and the lease
 * buys nothing; a fractional one is compared against `now()` in Postgres and against whole ms
 * here; `Infinity` never expires, so the rows of a relay that died are stranded forever — the one
 * failure the lease exists to bound. `X_INVARIANT` because this is a caller-argument check with no
 * dedicated code, the generic `@ultimat3/db` already borrows for the same shape.
 */
export function resolveClaimLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTBOX_CLAIM_LEASE_MS;
  assert(
    Number.isInteger(value) && value > 0,
    `outbox claimLeaseMs is ${String(value)}, which is not a positive whole number of milliseconds`,
    'pass a positive whole claimLeaseMs: 30_000 — createPgOutboxStore({ executor, txExecutor, claimLeaseMs: 30_000 }) — or omit the field for the 30s default',
  );
  return value;
}
