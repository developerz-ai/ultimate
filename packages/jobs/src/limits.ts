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

/** Tenant key resolution. Structural on purpose: `jobs` must not import the auth types. */
export function tenantKeyFrom(actor: { readonly orgId?: string } | undefined): string {
  return actor?.orgId ?? NO_TENANT;
}

export function createLimiter(config: LimitConfig, clock: Clock = systemClock): Limiter {
  const byQueue = new Map<string, number>();
  const byTenant = new Map<string, number>();
  const starts = new Map<string, number[]>();
  const refusals = new Map<string, LimitReason>();
  let global = 0;

  const tenantOf = (key: LimitKey): string => key.tenantId ?? NO_TENANT;
  const bump = (map: Map<string, number>, key: string, delta: number): void => {
    map.set(key, Math.max(0, (map.get(key) ?? 0) + delta));
  };

  const rateBlocked = (tenant: string): boolean => {
    const rate = config.ratePerTenant;
    if (rate === undefined) return false;
    const at = nowMs(clock);
    const window = (starts.get(tenant) ?? []).filter((stamp) => stamp > at - rate.windowMs);
    starts.set(tenant, window);
    return window.length >= rate.limit;
  };

  return {
    tryAcquire(key) {
      const tenant = tenantOf(key);
      const refusalKey = `${key.queue}\u0000${tenant}`;

      if (config.global !== undefined && global >= config.global) {
        refusals.set(refusalKey, 'global');
        return undefined;
      }
      if (config.perQueue !== undefined && (byQueue.get(key.queue) ?? 0) >= config.perQueue) {
        refusals.set(refusalKey, 'per-queue');
        return undefined;
      }
      if (config.perTenant !== undefined && (byTenant.get(tenant) ?? 0) >= config.perTenant) {
        refusals.set(refusalKey, 'per-tenant');
        return undefined;
      }
      if (rateBlocked(tenant)) {
        refusals.set(refusalKey, 'rate');
        return undefined;
      }

      global += 1;
      bump(byQueue, key.queue, 1);
      bump(byTenant, tenant, 1);
      if (config.ratePerTenant !== undefined) {
        starts.set(tenant, [...(starts.get(tenant) ?? []), nowMs(clock)]);
      }
      refusals.delete(refusalKey);

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
      return refusals.get(`${key.queue}\u0000${tenantOf(key)}`);
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
      };
    },
  };
}
