/**
 * The process default meter store: one bounded Map, each draw a synchronous check-and-add with no
 * `await` between the two, so parallel calls in one process cannot overshoot. `scope: 'process'`:
 * N replicas each holding one enforce N × every limit — the boot installs the Postgres store.
 */

import { finiteCount } from '@ultimat3/core';
import type { MeterPeriod } from './meter';
import { METER_PERIODS } from './meter';
import { meterWindow } from './meter-period';
import type { MeterDraw, MeterDrawResult, MeterKey, MeterStore } from './meter-store';

/** One entry per tenant × meter × period declaration — the bound, not a cache size. */
export const DEFAULT_MAX_METER_KEYS = 20_000;

export interface MemoryMeterStoreOptions {
  readonly maxKeys?: number;
}

interface Counter {
  periodStartMs: number;
  /** When `periodStartMs`'s period ends; `Infinity` for a period key this store cannot read. */
  periodEndMs: number;
  used: number;
  warned: boolean;
}

const PERIODS: ReadonlySet<string> = new Set<string>(METER_PERIODS);

/** `day@UTC` → the end of the period starting at `startMs`; the zone is UTC, the only one. */
function periodEnd(period: string, startMs: number): number {
  const name = period.split('@')[0] ?? '';
  return PERIODS.has(name)
    ? meterWindow(name as MeterPeriod, startMs).endMs
    : Number.POSITIVE_INFINITY;
}

/** A JSON tuple, never a joined string: no subject or meter can forge another's key. */
const keyOf = (key: MeterKey): string => JSON.stringify([key.subject, key.meter, key.period]);

export function memoryMeterStore(options: MemoryMeterStoreOptions = {}): MeterStore {
  const maxKeys = finiteCount(
    'memoryMeterStore',
    'maxKeys',
    options.maxKeys ?? DEFAULT_MAX_METER_KEYS,
    1,
  );
  const counters = new Map<string, Counter>();

  /** The latest period start any draw named: a moment known to have passed, with no clock read. */
  let passedMs = Number.NEGATIVE_INFINITY;

  /**
   * Past the bound a counter whose period already ENDED goes first — it is worth nothing — then the
   * oldest period start, then insertion order. By start alone a live month counter went before an
   * hour counter that had finished. Forgetting a live counter forgives that tenant's usage, which
   * is a weaker limit in one process, never a refusal of somebody who is within theirs.
   */
  const evict = (): void => {
    if (counters.size < maxKeys) return;
    let victim: string | undefined;
    let victimFinished = false;
    let victimStart = Number.POSITIVE_INFINITY;
    for (const [id, counter] of counters) {
      const finished = counter.periodEndMs <= passedMs;
      if (finished && !victimFinished) {
        victim = id;
        victimFinished = true;
        victimStart = counter.periodStartMs;
      } else if (finished === victimFinished && counter.periodStartMs < victimStart) {
        victim = id;
        victimStart = counter.periodStartMs;
      }
    }
    if (victim !== undefined) counters.delete(victim);
  };

  return {
    scope: 'process',

    async draw(request: MeterDraw): Promise<MeterDrawResult> {
      if (Number.isFinite(request.periodStartMs))
        passedMs = Math.max(passedMs, request.periodStartMs);
      const id = keyOf(request);
      const existing = counters.get(id);
      // A later period resets the count; an EARLIER one (a replica whose clock runs behind) adds to
      // the current one — the Postgres statement's `greatest`, so both stores answer alike.
      const current =
        existing === undefined || request.periodStartMs > existing.periodStartMs
          ? undefined
          : existing;
      const used = (current?.used ?? 0) + 1;
      if (used > request.limit) {
        return { allowed: false, used: current?.used ?? 0, warned: current?.warned ?? false };
      }
      if (current === undefined) {
        if (existing === undefined) evict();
        counters.set(id, {
          periodStartMs: request.periodStartMs,
          periodEndMs: periodEnd(request.period, request.periodStartMs),
          used,
          warned: false,
        });
        return { allowed: true, used, warned: false };
      }
      current.used = used;
      return { allowed: true, used, warned: current.warned };
    },

    async claimWarning(key, periodStartMs): Promise<boolean> {
      const counter = counters.get(keyOf(key));
      if (counter === undefined || counter.periodStartMs !== periodStartMs || counter.warned) {
        return false;
      }
      counter.warned = true;
      return true;
    },

    async releaseWarning(key, periodStartMs): Promise<void> {
      const counter = counters.get(keyOf(key));
      if (counter !== undefined && counter.periodStartMs === periodStartMs) counter.warned = false;
    },
  };
}
