/**
 * The process default meter store: one bounded Map, each draw a synchronous check-and-add with no
 * `await` between the two, so parallel calls in one process cannot overshoot. `scope: 'process'`:
 * N replicas each holding one enforce N × every limit — the boot installs the Postgres store.
 */

import { finiteCount } from '@ultimat3/core';
import type { ChainLink } from './meter-fifo';
import { Chain, Fifo } from './meter-fifo';
import { meterWindow, periodOfKey, previousPeriodStart } from './meter-period';
import type { MeterDraw, MeterDrawResult, MeterKey, MeterStore } from './meter-store';

/** One entry per tenant × meter × period declaration — the bound, not a cache size. */
export const DEFAULT_MAX_METER_KEYS = 20_000;

/** Draw keys remembered across every counter — the bound on keyed draws, not a cache size. */
export const DEFAULT_MAX_METER_DRAW_KEYS = 200_000;

export interface MemoryMeterStoreOptions {
  readonly maxKeys?: number;
  readonly maxDrawKeys?: number;
}

interface Counter {
  periodStartMs: number;
  /** When `periodStartMs`'s period ends; `Infinity` for a period key this store cannot read. */
  periodEndMs: number;
  used: number;
  warned: boolean;
  /** Draw keys that counted in THIS counter's period. */
  keys: Set<string>;
  /** `keys` oldest first: a key leaves `keys` only from this head, or with the whole set. */
  order: Fifo<string>;
  /** Draw keys of the period just before, kept only when the counter rolled over from it. */
  previous: Set<string>;
  /** Its place in the store's `holdingKeys` / `holdingPrevious`, while its set is nonempty. */
  keysLink: ChainLink<Counter> | undefined;
  previousLink: ChainLink<Counter> | undefined;
}

/** `day@UTC` → the end of the period starting at `startMs`; the zone is UTC, the only one. */
function periodEnd(period: string, startMs: number): number {
  const name = periodOfKey(period);
  return name === undefined ? Number.POSITIVE_INFINITY : meterWindow(name, startMs).endMs;
}

/** A JSON tuple, never a joined string: no subject or meter can forge another's key. */
const keyOf = (key: MeterKey): string => JSON.stringify([key.subject, key.meter, key.period]);

/**
 * Whether `drawKey` already counted on `counter`, judged from the period `effectiveMs` the draw
 * lands in: a key counted in that period or the one before it repeats, an older one does not.
 */
function counted(counter: Counter, period: string, drawKey: string, effectiveMs: number): boolean {
  const keptSince = previousPeriodStart(period, effectiveMs);
  if (counter.keys.has(drawKey)) return counter.periodStartMs >= keptSince;
  return (
    counter.previous.has(drawKey) && previousPeriodStart(period, counter.periodStartMs) >= keptSince
  );
}

export function memoryMeterStore(options: MemoryMeterStoreOptions = {}): MeterStore {
  const maxKeys = finiteCount(
    'memoryMeterStore',
    'maxKeys',
    options.maxKeys ?? DEFAULT_MAX_METER_KEYS,
    1,
  );
  const maxDrawKeys = finiteCount(
    'memoryMeterStore',
    'maxDrawKeys',
    options.maxDrawKeys ?? DEFAULT_MAX_METER_DRAW_KEYS,
    1,
  );
  const counters = new Map<string, Counter>();
  /** Every counter's `keys` and `previous` together: kept exact so the bound costs no scan. */
  let drawKeys = 0;
  /**
   * The counters holding a nonempty `previous` / `keys`, in the order each became nonempty, so a
   * saturated draw finds another counter's keys without a scan. A counter leaves the moment its set
   * empties or it retires (evicted, or replaced by its next period): a retired counter kept here
   * would hold its keys past both bounds.
   */
  const holdingPrevious = new Chain<Counter>();
  const holdingKeys = new Chain<Counter>();
  const dropPrevious = (counter: Counter): void => {
    if (counter.previousLink !== undefined) holdingPrevious.unlink(counter.previousLink);
    counter.previousLink = undefined;
  };
  const dropKeys = (counter: Counter): void => {
    if (counter.keysLink !== undefined) holdingKeys.unlink(counter.keysLink);
    counter.keysLink = undefined;
  };
  const retire = (counter: Counter): void => {
    dropPrevious(counter);
    dropKeys(counter);
  };

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
    const gone = victim === undefined ? undefined : counters.get(victim);
    if (victim === undefined || gone === undefined) return;
    drawKeys -= gone.keys.size + gone.previous.size;
    retire(gone);
    counters.delete(victim);
  };

  /**
   * Past the draw-key bound, a period-before set goes first — this counter's, else any — then the
   * oldest key of this counter, else of any. Forgetting a key lets its retry count again: a weaker
   * guarantee in one process, as forgetting a counter is, never a refusal of a draw within limit.
   * A durable, shared memory of keys is the Postgres store's.
   */
  const forgetKey = (counter: Counter): void => {
    if (drawKeys < maxDrawKeys) return;
    const withPrevious = counter.previous.size > 0 ? counter : holdingPrevious.first();
    if (withPrevious !== undefined) {
      drawKeys -= withPrevious.previous.size;
      withPrevious.previous = new Set();
      dropPrevious(withPrevious);
      return;
    }
    const holder = counter.keys.size > 0 ? counter : holdingKeys.first();
    const oldest = holder?.order.shift();
    if (holder === undefined || oldest === undefined) return;
    holder.keys.delete(oldest);
    drawKeys -= 1;
    if (holder.keys.size === 0) dropKeys(holder);
  };

  const remember = (counter: Counter, drawKey: string | undefined): void => {
    if (drawKey === undefined || counter.keys.has(drawKey)) return;
    forgetKey(counter);
    counter.keys.add(drawKey);
    counter.order.push(drawKey);
    counter.keysLink ??= holdingKeys.push(counter);
    drawKeys += 1;
  };

  return {
    scope: 'process',
    keyedDraws: true,

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
      // The counter's period after this draw, answered to a keyed draw (`drawMeter` reads its reset
      // off it); a `meter:` gate's call always draws its own period, so it is left off there.
      const at =
        request.drawKey === undefined
          ? {}
          : { periodStartMs: current?.periodStartMs ?? request.periodStartMs };
      const spent = current?.used ?? 0;
      const warned = current?.warned ?? false;
      const drawKey = request.drawKey;
      if (
        drawKey !== undefined &&
        existing !== undefined &&
        counted(existing, request.period, drawKey, current?.periodStartMs ?? request.periodStartMs)
      ) {
        return { allowed: true, used: spent, warned, replayed: true, ...at };
      }
      const used = spent + (request.amount ?? 1);
      if (used > request.limit) return { allowed: false, used: spent, warned, ...at };
      if (current === undefined) {
        if (existing === undefined) evict();
        // A rollover keeps the keys of the period just before, whole: a retry just after the reset
        // must still find the draw it repeats. Older ones are dropped as one set, never scanned.
        const adjacent =
          existing !== undefined &&
          existing.periodStartMs === previousPeriodStart(request.period, request.periodStartMs);
        if (existing !== undefined) {
          drawKeys -= existing.previous.size + (adjacent ? 0 : existing.keys.size);
          retire(existing);
        }
        const counter: Counter = {
          periodStartMs: request.periodStartMs,
          periodEndMs: periodEnd(request.period, request.periodStartMs),
          used,
          warned: false,
          keys: new Set(),
          order: new Fifo(),
          previous: adjacent ? existing.keys : new Set(),
          keysLink: undefined,
          previousLink: undefined,
        };
        counters.set(id, counter);
        if (counter.previous.size > 0) counter.previousLink = holdingPrevious.push(counter);
        remember(counter, drawKey);
        return { allowed: true, used, warned: false, ...at };
      }
      current.used = used;
      // Stamped with the counter's period, not the request's: a lagging draw counted in this one.
      remember(current, drawKey);
      return { allowed: true, used, warned: current.warned, ...at };
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
