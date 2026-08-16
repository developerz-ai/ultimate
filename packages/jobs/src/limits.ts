// Concurrency and rate limits, enforced at claim time. Multi-tenant reality: one org's
// 50k-row import must not consume every worker slot, so the tenant key comes from the
// actor's `orgId` and is carried on the queue row — never re-derived from the payload.
//
// **Every count in this file is PER PROCESS.** Three `Map`s in one heap: twenty worker pods with
// `perTenant: 2` run forty concurrent jobs for that tenant, and `ratePerTenant`'s window is lost
// on every deploy, so a rolling restart hands every tenant a fresh full allowance. That is a
// deliberate design and not a defect — it is the fast path, decided with no round trip, and it is
// what keeps ONE pod from starving its own queues. It is not a fleet ceiling and never was; the
// docstrings below say so where they used to say the opposite. The fleet gate is
// `JobDriver.leases` (`leases.ts`), which counts slots in a row every replica can see, and it is
// what `job.concurrency` is enforced with.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { nowMs } from './clock';

export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

export interface LimitConfig {
  /** Max concurrent runs per tenant IN THIS PROCESS, across every queue. */
  readonly perTenant?: number;
  /** Max concurrent runs per queue IN THIS PROCESS, across every tenant. */
  readonly perQueue?: number;
  /**
   * Ceiling on concurrent runs IN THIS PROCESS. Not fleet-wide — the doc line here said
   * "fleet-wide ceiling for this worker process", which is two different numbers in one sentence
   * and the code always meant the second. Multiply by your replica count to get the fleet's.
   */
  readonly global?: number;
  /**
   * Starts per tenant per window, IN THIS PROCESS — protects downstream APIs, not just CPU. The
   * window is in memory, so a deploy resets it: a rolling restart grants every tenant a full
   * fresh allowance. Size it for a per-pod budget, never for a partner's contractual rate.
   */
  readonly ratePerTenant?: RateLimit;
}

export interface LimitKey {
  readonly queue: string;
  readonly tenantId?: string;
}

/** Returned on success; `release()` is idempotent so a double-release cannot leak slots. */
export interface Lease {
  readonly queue: string;
  readonly tenantId: string;
  release(): void;
}

export type LimitReason = 'per-tenant' | 'per-queue' | 'global' | 'rate';

export interface LimitSnapshot {
  readonly global: number;
  readonly byQueue: Readonly<Record<string, number>>;
  readonly byTenant: Readonly<Record<string, number>>;
  readonly config: LimitConfig;
  /**
   * The per-tenant state that outlives a run, counted — the bound, observable. `byQueue` and
   * `byTenant` are already bounded by what is in flight (a counter at zero is deleted); these two
   * are the maps a cap has to hold, so a test can assert the bound rather than assume it.
   */
  readonly tracked: {
    readonly rateWindows: number;
    readonly refusals: number;
  };
}

export interface Limiter {
  /** `undefined` means "over a limit" — the claim loop leaves the job for another worker. */
  tryAcquire(key: LimitKey): Lease | undefined;
  /** Which limit blocked the last refusal for this key, for `/_x` and logs. */
  blockedBy(key: LimitKey): LimitReason | undefined;
  inFlight(key?: LimitKey): number;
  snapshot(): LimitSnapshot;
}

export const NO_TENANT = 'global';

/**
 * How long a refusal is worth reporting. `blockedBy` feeds `/_x` and a log line — "why was this
 * tenant's job left on the queue just now" — and an answer from an hour ago is not that. Past it
 * the entry is indistinguishable from a missing one, so the sweep drops it for free.
 */
const REFUSAL_TTL_MS = 60_000;

/** An idle limiter still sweeps this often, so a burst's state does not sit until the next one. */
const SWEEP_EVERY_MS = 60_000;

/**
 * The backstop on the two maps that outlive a run. Self-service org creation mints tenants without
 * limit and a worker process does not restart, so `starts` and `refusals` were one permanent entry
 * per org that ever queued anything. The concurrency counters need no cap: they are deleted the
 * moment they reach zero, which bounds them by the in-flight runs of one process.
 */
export const DEFAULT_MAX_LIMIT_TENANTS = 20_000;

/** Tenant key resolution. Structural on purpose: `jobs` must not import the auth types. */
export function tenantKeyFrom(actor: { readonly orgId?: string } | undefined): string {
  return actor?.orgId ?? NO_TENANT;
}

export function createLimiter(
  config: LimitConfig,
  clock: Clock = systemClock,
  options: { readonly maxTenants?: number | undefined } = {},
): Limiter {
  const maxTenants = Math.max(1, Math.floor(options.maxTenants ?? DEFAULT_MAX_LIMIT_TENANTS));
  const evictTo = Math.max(1, Math.floor(maxTenants * 0.9));
  const byQueue = new Map<string, number>();
  const byTenant = new Map<string, number>();
  const starts = new Map<string, number[]>();
  const refusals = new Map<string, { reason: LimitReason; atMs: number }>();
  let global = 0;
  let lastSweepMs = Number.NEGATIVE_INFINITY;

  const tenantOf = (key: LimitKey): string => key.tenantId ?? NO_TENANT;
  /**
   * A counter at zero is DELETED, never stored. `Math.max(0, ...)` wrote `0` and kept the key, so a
   * worker that ran one job for an org held that org's name for the life of the process — and a
   * process that never restarts plus self-service org creation is an unbounded map. Zero and
   * absent already answer identically everywhere (`?? 0`), so dropping it costs nothing.
   */
  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    const next = Math.max(0, (map.get(key) ?? 0) + delta);
    if (next === 0) map.delete(key);
    else map.set(key, next);
  };

  /**
   * The two maps that outlive a run, swept together. A spent rate window and a stale refusal are
   * both indistinguishable from a missing entry, so those go for free; only if that is not enough
   * does the cap evict live state, and then the LEAST throttled tenants go first — discarding a
   * full window is what would hand a tenant a free rate reset, which is the order
   * `@ultimat3/http`'s `memoryRateLimitStore` evicts in and for the same reason.
   */
  const sweep = (at: number): void => {
    lastSweepMs = at;
    const windowMs = config.ratePerTenant?.windowMs ?? 0;
    for (const [tenant, stamps] of starts) {
      if (stamps.length === 0 || (stamps.at(-1) ?? 0) <= at - windowMs) starts.delete(tenant);
    }
    for (const [key, refusal] of refusals) {
      if (refusal.atMs <= at - REFUSAL_TTL_MS) refusals.delete(key);
    }
    if (starts.size > maxTenants) {
      const emptiest = [...starts.entries()].sort((a, b) => a[1].length - b[1].length);
      for (const [tenant] of emptiest) {
        if (starts.size <= evictTo) break;
        starts.delete(tenant);
      }
    }
    if (refusals.size > maxTenants) {
      const oldest = [...refusals.entries()].sort((a, b) => a[1].atMs - b[1].atMs);
      for (const [key] of oldest) {
        if (refusals.size <= evictTo) break;
        refusals.delete(key);
      }
    }
  };

  /** Swept on a burst and on a schedule, so an idle limiter still lets its state go. */
  const maybeSweep = (at: number): void => {
    if (
      starts.size > maxTenants ||
      refusals.size > maxTenants ||
      at - lastSweepMs >= SWEEP_EVERY_MS
    )
      sweep(at);
  };

  const rateBlocked = (tenant: string, at: number): boolean => {
    const rate = config.ratePerTenant;
    if (rate === undefined) return false;
    const window = (starts.get(tenant) ?? []).filter((stamp) => stamp > at - rate.windowMs);
    // An empty window is a tenant with no rate state at all — deleted rather than stored as `[]`,
    // which is what kept one array per org that ever ran a job.
    if (window.length === 0) starts.delete(tenant);
    else starts.set(tenant, window);
    return window.length >= rate.limit;
  };

  return {
    tryAcquire(key) {
      const tenant = tenantOf(key);
      const refusalKey = `${key.queue}\u0000${tenant}`;
      const at = nowMs(clock);
      const refuse = (reason: LimitReason): undefined => {
        refusals.set(refusalKey, { reason, atMs: at });
        maybeSweep(at);
        return undefined;
      };

      if (config.global !== undefined && global >= config.global) return refuse('global');
      if (config.perQueue !== undefined && (byQueue.get(key.queue) ?? 0) >= config.perQueue) {
        return refuse('per-queue');
      }
      if (config.perTenant !== undefined && (byTenant.get(tenant) ?? 0) >= config.perTenant) {
        return refuse('per-tenant');
      }
      if (rateBlocked(tenant, at)) return refuse('rate');

      global += 1;
      bump(byQueue, key.queue, 1);
      bump(byTenant, tenant, 1);
      if (config.ratePerTenant !== undefined) {
        starts.set(tenant, [...(starts.get(tenant) ?? []), at]);
      }
      refusals.delete(refusalKey);
      maybeSweep(at);

      let released = false;
      return {
        queue: key.queue,
        tenantId: tenant,
        release() {
          if (released) return;
          released = true;
          global = Math.max(0, global - 1);
          bump(byQueue, key.queue, -1);
          bump(byTenant, tenant, -1);
        },
      };
    },

    blockedBy(key) {
      const refusal = refusals.get(`${key.queue}\u0000${tenantOf(key)}`);
      if (refusal === undefined) return undefined;
      // A refusal past its window answers as a missing one rather than as an explanation of a
      // decision nobody is looking at any more.
      if (refusal.atMs <= nowMs(clock) - REFUSAL_TTL_MS) return undefined;
      return refusal.reason;
    },

    inFlight(key) {
      if (key === undefined) return global;
      if (key.tenantId !== undefined) return byTenant.get(key.tenantId) ?? 0;
      return byQueue.get(key.queue) ?? 0;
    },

    snapshot() {
      return {
        global,
        byQueue: Object.fromEntries(byQueue),
        byTenant: Object.fromEntries(byTenant),
        config,
        tracked: { rateWindows: starts.size, refusals: refusals.size },
      };
    },
  };
}
