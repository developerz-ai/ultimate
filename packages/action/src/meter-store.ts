/**
 * The meter store SEAM: what a counter must answer, and the installed-store slot `invoke` draws
 * from. The process default is `memoryMeterStore()`; the boot installs `postgresMeterStore()` on
 * the pool it opened, so a tenant's day is one counter across every replica and every restart.
 */

import { adapterSlot } from '@ultimat3/core/adapter';
import { memoryMeterStore } from './meter-memory';

/** One counter: whose, which meter, which period declaration. */
export interface MeterKey {
  /** `org:<id>`, else `actor:<id>`, else `job:unattributed` or `anonymous` — `meter-gate.ts`. */
  readonly subject: string;
  readonly meter: string;
  /** `day@UTC` — the period AND its zone, so a re-declared period is a new counter. */
  readonly period: string;
}

export interface MeterDraw extends MeterKey {
  /** The current period's start, epoch ms. A later start than the stored one resets the count. */
  readonly periodStartMs: number;
  /** The allowance for THIS call, resolved by the caller: a plan change applies at once. */
  readonly limit: number;
  /** Units this draw adds, a positive safe integer; absent is `1`: a `meter:` counts calls. */
  readonly amount?: number;
  /**
   * The draw's idempotency key (`drawMeter`'s `key`). A second draw under it, in the period it
   * counted in or the next, adds nothing and answers `replayed: true`; a refused draw leaves no
   * key behind, so its retry is judged afresh. "The period it counted in" is the counter's: a
   * lagging draw added to a counter already in the next period counted in that one.
   */
  readonly drawKey?: string;
}

export interface MeterDrawResult {
  /** `false`: the draw would pass `limit`, and nothing was counted. */
  readonly allowed: boolean;
  /** The count after this draw, or the count that refused it. */
  readonly used: number;
  /** Whether this period's warning was already claimed. */
  readonly warned: boolean;
  /** `true` when `drawKey` had already counted: `allowed`, and nothing was added. */
  readonly replayed?: boolean;
  /**
   * The start of the period the counter is in after this draw: later than `periodStartMs` when a
   * lagging replica drew against a counter already in the next period. Absent reads as the
   * request's own `periodStartMs`.
   */
  readonly periodStartMs?: number;
}

export interface MeterStore {
  /** Declared, never inferred: a driver knows where its counters live. */
  readonly scope: 'process' | 'shared';
  /**
   * `true` when `draw` adds `amount` and remembers `drawKey`, as `drawMeter` needs. A store written
   * before either field existed counts one call per draw and never replays, so `drawMeter` refuses
   * a store that does not declare it (`X_METER_INVALID`) rather than undercount in silence.
   */
  readonly keyedDraws?: boolean;
  /**
   * Count `amount` (one call when absent), atomically, only while the count stays within `limit`:
   * never a read followed by a write, so N parallel draws at the edge admit exactly the remainder.
   * Under a `drawKey`, N parallel draws with that key — on any replica — add it once.
   */
  draw(request: MeterDraw): Promise<MeterDrawResult>;
  /** Claim this period's warning. `true` for exactly one caller per period. */
  claimWarning(key: MeterKey, periodStartMs: number): Promise<boolean>;
  /** Give a claim back — the enqueue it was for failed, so the next draw may try again. */
  releaseWarning(key: MeterKey, periodStartMs: number): Promise<void>;
}

let base: MeterStore = memoryMeterStore();
/** The installed store: a stack over the process default, released in any order. */
const slot = adapterSlot<MeterStore>(() => base);

/**
 * The boot's installer (its release removes THIS install only, in any order — `adapterSlot`), on `@ultimat3/action/adapter` and never the `.` barrel: an app swaps the
 * store with `meterStore:` in `apps/<app>/runtime.ts`.
 */
export function installMeterStore(store: MeterStore): () => void {
  return slot.install(store);
}

export function getMeterStore(): MeterStore {
  return slot.current();
}

/** Back to a fresh process default. The boot's teardown, and a test's. */
export function resetMeterStore(): void {
  slot.reset();
  base = memoryMeterStore();
}
