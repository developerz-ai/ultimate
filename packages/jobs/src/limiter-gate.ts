// Spending a named `limiter()` around one run's body: a concurrency slot held for the run and a
// rate stamp held for the window, both rows in the installed driver's `LeaseStore`, so the budget
// holds across every replica. A refusal is `X_RATE_LIMITED`, deferred with the attempt uncounted.
//
// In front sits `limits.ts`' per-process fast path, refusing with no round trip what this process
// alone already proves is over.

import type { Clock } from '@ultimat3/core';
import { liveClock, logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import { DEFAULT_VISIBILITY_TIMEOUT_MS, jobDriver } from './driver';
import type { HeldLease, LeaseStore } from './leases';
import type { JobLimiter } from './limiter';
import type { LimiterRefusal } from './limiter-errors';
import { LimiterRefusedError, LimiterUnenforceableError } from './limiter-errors';
import { didWork, limiterFrame } from './limiter-frame';
import type { Limiter } from './limits';
import { concurrencyLimiter } from './limits';
import { type IntervalScheduler, type RenewalTimer, startRenewalTimer } from './renewal-timer';
import type { StepStore } from './steps-store';

export interface LimiterGateOptions {
  /** The store every replica counts in; `undefined` is a driver that has none. */
  readonly leases: () => { readonly store: LeaseStore | undefined; readonly driver: string };
  /** What a rate stamp dates its expiry by, for a refusal's Retry-After. Default: `liveClock`. */
  readonly clock?: Clock;
  /**
   * How long a held concurrency slot survives its process, how often it renews, and on what.
   * Each defaults to the running worker's (`limiter-frame.ts`: its visibility timeout, its
   * heartbeat interval, `WorkerOptions.schedule`), then to the visibility-timeout default.
   */
  readonly ttlMs?: number;
  readonly renewIntervalMs?: number;
  readonly schedule?: IntervalScheduler;
  /** Asked whether a run is a re-entry when no worker frame says so. Absent: never a re-entry. */
  readonly steps?: () => StepStore | undefined;
}

export interface LimiterGate {
  /** `body` under the limiter, or `LimiterRefusedError` before it starts. */
  run<T>(job: string, runId: string, body: () => Promise<T>): Promise<T>;
}

/**
 * The wait stated for a full concurrency cap: a slot frees when some run ends, which no row can
 * date, so the next look is a second away (plus `rateLimitDeferralMs`' spread).
 */
export const LIMITER_CONCURRENCY_RETRY_SECONDS = 1;

/**
 * Lease keys under their own prefix, the name encoded: `job:`, `job-key:` and `lock:` are taken,
 * and a limiter named like a job must not share that job's slot table.
 */
export const limiterLeaseKey = (name: string, member: LimiterRefusal): string =>
  `limiter:${encodeURIComponent(name)}:${member}`;

/** A rate stamp's holder carries its expiry, so a refusal can say when the window next opens. */
const stampHolder = (expiresAtMs: number, runId: string): string =>
  `${expiresAtMs}|${runId}|${crypto.randomUUID()}`;

const expiryOf = (holder: string): number => Number(holder.slice(0, holder.indexOf('|')));

/**
 * One grant attempt, retried ONCE when the refusal was contention rather than a full table:
 * `SQL_LEASE_ACQUIRE` can refuse a free slot when two workers reach for the same one, and a
 * deferral for a budget that was not spent is a run delayed for nothing.
 */
async function grant(
  store: LeaseStore,
  key: string,
  limit: number,
  ttlMs: number,
  holder: string,
): Promise<{ readonly lease: HeldLease | undefined; readonly holders: readonly string[] }> {
  for (let tries = 0; ; tries += 1) {
    const lease = await store.acquire(key, limit, ttlMs, holder);
    if (lease !== undefined) return { lease, holders: [] };
    const holders = await store.holders(key);
    if (holders.length >= limit || tries >= 1) return { lease: undefined, holders };
  }
}

/** Never fails the run over bookkeeping: an unreleased slot expires on its own TTL. */
async function releaseSlot(
  store: LeaseStore,
  slot: HeldLease,
  limiter: string,
  job: string,
): Promise<void> {
  await store.release(slot).catch((error: unknown) => {
    logger.warn('jobs.limiter.release-failed', { limiter, job, error: renderThrowable(error) });
  });
}

interface RenewOptions {
  readonly ttlMs: number;
  readonly renewIntervalMs: number;
  readonly schedule: IntervalScheduler | undefined;
  readonly limiter: string;
  readonly job: string;
  readonly runId: string;
}

/**
 * The held slot, renewed while the body runs. A loss is LOGGED, never cancelled: a body past a
 * lost slot runs beside another holder's — the edge `job.concurrency` documents for a body that
 * ignores its signal. The run's signal is the worker's (`run-signal.ts`), out of this gate's reach.
 */
function renewSlot(store: LeaseStore, held: HeldLease, options: RenewOptions): RenewalTimer {
  const timer = startRenewalTimer(
    options.renewIntervalMs,
    async () => {
      const renewed = await store.renew(held, options.ttlMs);
      if (timer.stopped() || renewed !== false) return;
      timer.stop();
      logger.error('jobs.limiter.slot-lost', {
        limiter: options.limiter,
        job: options.job,
        runId: options.runId,
      });
    },
    options.schedule,
  );
  return timer;
}

export function limiterGate(limiter: JobLimiter, options: LimiterGateOptions): LimiterGate {
  const clock = options.clock ?? liveClock;
  /** Read per run: the worker's numbers belong to the run in progress, not to the gate. */
  const timings = () => {
    const frame = limiterFrame();
    const ttlMs = options.ttlMs ?? frame?.ttlMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS;
    return {
      ttlMs,
      renewIntervalMs:
        options.renewIntervalMs ?? frame?.renewIntervalMs ?? Math.max(1, Math.floor(ttlMs / 3)),
      schedule: options.schedule ?? frame?.schedule,
    };
  };
  /**
   * A rate counts STARTS, and a run that already did work (`didWork`) has started: a resume after
   * `step.sleep`/`waitForEvent`, or a retry past a completed step, spends none. The worker's claim
   * says so for free; without one, the step store is asked (one read, rate-limited runs only).
   */
  const reentered = async (runId: string): Promise<boolean> => {
    const said = limiterFrame()?.reentered;
    if (said !== undefined) return said;
    const store = options.steps?.();
    return store === undefined ? false : didWork(await store.list(runId));
  };
  // The fast path: this process's own count can only be at or below the fleet's, so a refusal
  // here is always one the fleet would make too. Keyed by the limiter's name as its one "queue".
  // CONCURRENCY only: a rate window is TIME, and the store keeps its own (Postgres' `now()`, or
  // the memory driver's clock) — a second window on this process's clock disagreed with it under
  // a frozen test clock and never reopened. Counting runs needs no clock at all.
  const local: Limiter = concurrencyLimiter(
    limiter.concurrency === undefined ? {} : { perQueue: limiter.concurrency },
    clock,
  );
  const key = { queue: limiter.name };
  const rateSpacing = (): number =>
    limiter.rate === undefined ? 0 : limiter.rate.windowMs / limiter.rate.limit / 1_000;

  const refused = (job: string, refusal: LimiterRefusal, seconds: number): LimiterRefusedError =>
    new LimiterRefusedError({
      limiter: limiter.name,
      job,
      refusal,
      retryAfterSeconds: Math.max(0, seconds),
    });

  return {
    async run(job, runId, body) {
      const { store, driver } = options.leases();
      if (store === undefined) {
        throw new LimiterUnenforceableError({ limiter: limiter.name, job, driver });
      }
      const fast = local.tryAcquire(key);
      if (fast === undefined) {
        throw refused(job, 'concurrency', LIMITER_CONCURRENCY_RETRY_SECONDS);
      }

      const { ttlMs, renewIntervalMs, schedule } = timings();
      let slot: HeldLease | undefined;
      try {
        if (limiter.concurrency !== undefined) {
          const taken = await grant(
            store,
            limiterLeaseKey(limiter.name, 'concurrency'),
            limiter.concurrency,
            ttlMs,
            `${runId}|${crypto.randomUUID()}`,
          );
          if (taken.lease === undefined) {
            throw refused(job, 'concurrency', LIMITER_CONCURRENCY_RETRY_SECONDS);
          }
          slot = taken.lease;
        }
        if (limiter.rate !== undefined && !(await reentered(runId))) {
          const at = nowMs(clock);
          // Never released: a start stays counted for its whole window, and the TTL is the window.
          const taken = await grant(
            store,
            limiterLeaseKey(limiter.name, 'rate'),
            limiter.rate.limit,
            limiter.rate.windowMs,
            stampHolder(at + limiter.rate.windowMs, runId),
          );
          if (taken.lease === undefined) {
            const opens = Math.min(...taken.holders.map(expiryOf).filter(Number.isFinite));
            throw refused(
              job,
              'rate',
              Number.isFinite(opens) ? (opens - at) / 1_000 : rateSpacing(),
            );
          }
        }
      } catch (error) {
        // Never started: this process's count and the fleet slot go back.
        fast.abandon();
        if (slot !== undefined) await releaseSlot(store, slot, limiter.name, job);
        throw error;
      }

      const renewal =
        slot === undefined
          ? undefined
          : renewSlot(store, slot, {
              ttlMs,
              renewIntervalMs,
              schedule,
              runId,
              job,
              limiter: limiter.name,
            });
      try {
        return await body();
      } finally {
        fast.release();
        if (slot !== undefined) {
          renewal?.stop();
          await releaseSlot(store, slot, limiter.name, job);
        }
      }
    },
  };
}

/** One gate per limiter per process: the fast path is this heap's count of THAT budget. */
const gates = new WeakMap<JobLimiter, LimiterGate>();

/** The installed driver's gate for `limiter` — what `job({ limiter })` runs its body through. */
export function limiterGateFor(limiter: JobLimiter): LimiterGate {
  let gate = gates.get(limiter);
  if (gate === undefined) {
    gate = limiterGate(limiter, {
      leases: () => {
        const driver = jobDriver();
        return { store: driver?.leases, driver: driver?.name ?? 'none' };
      },
      steps: () => jobDriver()?.steps,
    });
    gates.set(limiter, gate);
  }
  return gate;
}
