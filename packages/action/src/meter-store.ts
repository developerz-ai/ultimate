/**
 * The meter store SEAM: what a counter must answer, and the installed-store slot `invoke` draws
 * from. The process default is `memoryMeterStore()`; the boot installs `postgresMeterStore()` on
 * the pool it opened, so a tenant's day is one counter across every replica and every restart.
 */

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
}

export interface MeterDrawResult {
  /** `false`: the draw would pass `limit`, and nothing was counted. */
  readonly allowed: boolean;
  /** The count after this draw, or the count that refused it. */
  readonly used: number;
  /** Whether this period's warning was already claimed. */
  readonly warned: boolean;
}

export interface MeterStore {
  /** Declared, never inferred: a driver knows where its counters live. */
  readonly scope: 'process' | 'shared';
  /**
   * Count one call, atomically, only while the count stays within `limit`: never a read followed
   * by a write, so N parallel draws at the edge admit exactly the remainder.
   */
  draw(request: MeterDraw): Promise<MeterDrawResult>;
  /** Claim this period's warning. `true` for exactly one caller per period. */
  claimWarning(key: MeterKey, periodStartMs: number): Promise<boolean>;
  /** Give a claim back — the enqueue it was for failed, so the next draw may try again. */
  releaseWarning(key: MeterKey, periodStartMs: number): Promise<void>;
}

let installed: MeterStore = memoryMeterStore();

export function setMeterStore(store: MeterStore): void {
  installed = store;
}

export function getMeterStore(): MeterStore {
  return installed;
}

/** Back to a fresh process default. The boot's teardown, and a test's. */
export function resetMeterStore(): void {
  installed = memoryMeterStore();
}
