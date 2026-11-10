// The three `X_LOCK_*` refusals `withLock()` ends on: not taken within `wait`, lost mid-work, and
// nothing to hold it in. Codes, titles and retry classes are `error-codes.ts`'s; the key is printed
// JSON-quoted, since an app builds it from its own data (`invoice:${id}`).

import { UltimateError } from '@ultimat3/core';
import './error-codes';

/** Another holder kept the key for the whole `wait` bound. Retryable: contention ends. */
export class LockNotAcquiredError extends UltimateError {
  constructor(input: { key: string; waitMs: number; holders: readonly string[] }) {
    super({
      code: 'X_LOCK_NOT_ACQUIRED',
      cause: `withLock(${JSON.stringify(input.key)}) waited ${input.waitMs}ms and another holder (${input.holders.length === 0 ? 'released a moment ago' : input.holders.join(', ')}) kept the key throughout`,
      fix: `withLock(${JSON.stringify(input.key)}, fn, { ttl, wait: '${Math.max(1, Math.ceil((input.waitMs * 2) / 1000))}s' })   # in the calling file: a longer wait:, or let the caller retry`,
      meta: { key: input.key, waitMs: input.waitMs, holders: [...input.holders] },
    });
  }
}

/**
 * A renewal was refused, or none landed within one `ttl`: the key may be someone else's now. The
 * reason `fn`'s signal aborts with — a write fenced on the token is what stops the stale holder.
 */
export class LockLostError extends UltimateError {
  constructor(input: { key: string; token: number; ttlMs: number }) {
    super({
      code: 'X_LOCK_LOST',
      cause: `withLock(${JSON.stringify(input.key)}) lost the lock held as ${input.token}: no renewal landed within its ttl of ${input.ttlMs}ms, so another holder may have it`,
      fix: `withLock(${JSON.stringify(input.key)}, fn, { ttl: '${Math.ceil((input.ttlMs * 4) / 1000)}s' })   # in the calling file: a longer ttl:, and fn hands lock.signal to every write it makes`,
      meta: { key: input.key, token: input.token, ttlMs: input.ttlMs },
    });
  }
}

/**
 * No job driver installed, one without a `leases` store, or a store that answers no `fence`: no
 * fleet-wide place to hold a key behind a token the database assigned.
 */
export class LockStoreMissingError extends UltimateError {
  constructor(input: { key: string; driver: string | undefined; fence?: boolean }) {
    const why =
      input.fence === true
        ? 'the lease store granted the key with no fence, so there is no token a write can be refused by'
        : input.driver === undefined
          ? 'no job driver is installed'
          : `the installed job driver "${input.driver}" has no leases`;
    super({
      code: 'X_LOCK_STORE_MISSING',
      cause: `withLock(${JSON.stringify(input.key)}) has no lease store to lock in: ${why}`,
      fix: 'jobs: postgresJobDriver()   # in apps/<app>/runtime.ts — or withLock(key, fn, { ttl, store }) in the calling file',
      meta: { key: input.key, driver: input.driver ?? null },
    });
  }
}
