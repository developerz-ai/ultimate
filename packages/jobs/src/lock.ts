// `withLock(key, fn, { ttl })`: one holder fleet-wide for `fn`, held in the job driver's
// `LeaseStore` (one slot, `lock:<key>`) — the same rows `job.concurrency` counts, so a lock needs
// no table, no Redis and no second mechanism. Not a primitive: a helper a job or action body calls.
// The holder renews at a third of `ttl`; a lost lease aborts `fn`'s signal with `X_LOCK_LOST`.

import type { SleepClock } from '@ultimat3/core';
import { ambientClock, assert, logger, renderThrowable, uuidV7 } from '@ultimat3/core';
import type { DurationInput } from './clock';
import { finiteDurationMs, nowMs } from './clock';
import { jobDriver } from './driver';
import type { HeldLease, LeaseStore } from './leases';
import { LockLostError, LockNotAcquiredError, LockStoreMissingError } from './lock-errors';
import type { IntervalScheduler, RenewalTimer } from './renewal-timer';
import { startRenewalTimer } from './renewal-timer';

/** Between two acquire attempts while another holder has the key. Never above `wait`'s remainder. */
export const DEFAULT_LOCK_POLL_MS = 100;

export interface WithLockOptions {
  /** REQUIRED. How long the key stays held if this process dies; renewed while `fn` runs. */
  readonly ttl: DurationInput;
  /** How long to keep trying before `X_LOCK_NOT_ACQUIRED`. Default: one `ttl`. `0`: one attempt. */
  readonly wait?: DurationInput;
  /** Between attempts. Default `DEFAULT_LOCK_POLL_MS`. */
  readonly poll?: DurationInput;
  /** Default: the installed job driver's `leases` (`postgresJobDriver` over `x_job_leases`). */
  readonly store?: LeaseStore;
  /** Default `ambientClock()`: the wait, the expiry bookkeeping and the token's timestamp. */
  readonly clock?: SleepClock;
  /** Gives up the WAIT (rejects with its reason); once held, it aborts `fn`'s signal too. */
  readonly signal?: AbortSignal;
  /** The renewal interval's seam — `renewal-timer.ts`'s, so a test renews when it says so. */
  readonly schedule?: IntervalScheduler;
}

/** What `fn` holds: the key, the fencing token and the signal a lost lease aborts. */
export interface HeldLock {
  readonly key: string;
  /**
   * The FENCING token: the store's number for this grant (`HeldLease.fence`), greater than every
   * token any earlier holder of any key got — the database's counter, never a clock. Write it
   * beside whatever `fn` changes and refuse a write carrying a smaller one: that is what stops a
   * holder that paused past its `ttl` (GC, a frozen VM) from writing after the next one took over.
   */
  readonly token: number;
  readonly signal: AbortSignal;
}

/** The lease key: its own prefix, so no lock ever shares a slot table with a job's cap. */
export const lockLeaseKey = (key: string): string => `lock:${encodeURIComponent(key)}`;

const storeFor = (key: string, options: WithLockOptions): LeaseStore => {
  if (options.store !== undefined) return options.store;
  const driver = jobDriver();
  if (driver?.leases === undefined) throw new LockStoreMissingError({ key, driver: driver?.name });
  return driver.leases;
};

async function acquire(
  store: LeaseStore,
  key: string,
  token: string,
  bounds: { ttlMs: number; waitMs: number; pollMs: number },
  clock: SleepClock,
  signal: AbortSignal | undefined,
  sent: (atMs: number) => void,
): Promise<HeldLease> {
  const leaseKey = lockLeaseKey(key);
  const deadline = nowMs(clock) + bounds.waitMs;
  for (;;) {
    signal?.throwIfAborted();
    const sentAt = nowMs(clock);
    const lease = await store.acquire(leaseKey, 1, bounds.ttlMs, token);
    if (lease !== undefined) {
      sent(sentAt);
      return lease;
    }
    const left = deadline - nowMs(clock);
    if (left <= 0) {
      const holders = await store.holders(leaseKey);
      throw new LockNotAcquiredError({ key, waitMs: bounds.waitMs, holders });
    }
    await clock.sleep(Math.min(bounds.pollMs, left), signal);
  }
}

/**
 * Run `fn` while this process alone holds `key` across the fleet, then release it. Refuses with
 * `X_LOCK_NOT_ACQUIRED` when `wait` passes first. If the lease is lost mid-run, `fn`'s signal
 * aborts and the call rejects with `X_LOCK_LOST` even when `fn` resolved: its work was not exclusive.
 */
export async function withLock<T>(
  key: string,
  fn: (lock: HeldLock) => Promise<T> | T,
  options: WithLockOptions,
): Promise<T> {
  const ttlMs = finiteDurationMs(options.ttl, 'withLock', 'ttl');
  assert(
    Number.isSafeInteger(ttlMs) && ttlMs >= 3,
    `withLock(${JSON.stringify(key)}) declares ttl: ${String(options.ttl)} — renewed at a third of it, so at least 3ms`,
    `withLock(${JSON.stringify(key)}, fn, { ttl: '30s' })   # in the calling file`,
  );
  const waitMs = Math.max(0, finiteDurationMs(options.wait ?? ttlMs, 'withLock', 'wait'));
  const pollMs = Math.max(
    1,
    finiteDurationMs(options.poll ?? DEFAULT_LOCK_POLL_MS, 'withLock', 'poll'),
  );
  const clock = options.clock ?? ambientClock();
  const store = storeFor(key, options);
  const holder = uuidV7(clock);
  // Stamped BEFORE the acquire that won: the store dates the expiry at its statement.
  let renewedAt = nowMs(clock);
  const lease = await acquire(
    store,
    key,
    holder,
    { ttlMs, waitMs, pollMs },
    clock,
    options.signal,
    (sentAt) => {
      renewedAt = sentAt;
    },
  );

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(options.signal?.reason);
  let lost: LockLostError | undefined;
  let timer: RenewalTimer | undefined;
  // Everything after the acquire is inside the `try`: a throw anywhere still hands the lease back.
  try {
    const token = lease.fence;
    if (token === undefined)
      throw new LockStoreMissingError({ key, driver: undefined, fence: true });
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });
    // An abort that landed while the acquire that SUCCEEDED was in flight fired no listener.
    if (options.signal?.aborted === true) controller.abort(options.signal.reason);
    const lapsed = (): boolean => nowMs(clock) - renewedAt >= ttlMs;
    const lose = (): void => {
      lost ??= new LockLostError({ key, token, ttlMs });
      if (!controller.signal.aborted) controller.abort(lost);
    };
    let renewing = false;
    // `worker-fleet-slots.ts`'s renewal: a renew hung on a dead socket never settles, so the
    // lapse is decided BEFORE the call, one renewal is in flight at a time, and a reply that
    // lands after the expiry it would have extended is still a loss.
    const renew = async (): Promise<void> => {
      if (lost !== undefined || timer?.stopped() === true) return;
      if (lapsed()) return lose();
      if (renewing) return;
      renewing = true;
      const sentAt = nowMs(clock);
      try {
        const held = await store.renew(lease, ttlMs);
        if (timer?.stopped() === true) return;
        if (held === false || lapsed()) return lose();
        renewedAt = sentAt;
      } catch (error: unknown) {
        logger.warn('jobs.lock.renew_failed', { key, error: renderThrowable(error) });
        if (timer?.stopped() !== true && lapsed()) lose();
      } finally {
        renewing = false;
      }
    };
    timer = startRenewalTimer(Math.max(1, Math.floor(ttlMs / 3)), renew, options.schedule);
    const result = await fn({ key, token, signal: controller.signal });
    if (lost !== undefined) throw lost;
    return result;
  } finally {
    timer?.stop();
    options.signal?.removeEventListener('abort', onOuterAbort);
    // Released only by this holder (the store checks `holder`); a failure leaves it to the TTL.
    await store.release(lease).catch((error: unknown) => {
      logger.warn('jobs.lock.release_failed', { key, error: renderThrowable(error) });
    });
  }
}
