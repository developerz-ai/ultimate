/**
 * The programmatic draw: `drawMeter(ctx, { meter, period, amount, limit, key })` counts work
 * measured after the fact — tokens, bytes, rows — on the counters a declared `meter:` uses, for the
 * same caller. One conditional add of `amount` in the installed store, idempotent under `key`.
 */

import type { Ctx } from '@ultimat3/core';
import { MeterExceededError, MeterInvalidError } from './errors-meter';
import { MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency-key';
import type { MeterPeriod, ResolvedLimit } from './meter';
import { assertMeterCounter, isMeterLimit } from './meter';
import { meterSubject, resolveMeterLimit } from './meter-gate';
import { meterPeriodKey, meterWindow } from './meter-period';
import { getMeterStore } from './meter-store';

export interface MeterDrawInput {
  /** The counter's name: a `meter:` with this name and period counts on the same one. */
  readonly meter: string;
  readonly period: MeterPeriod;
  /** Units this draw adds: a whole number, 1 or more. */
  readonly amount: number;
  /** Units allowed per period, or resolved per call from `{ ctx }` — the tenant's plan. */
  readonly limit: ResolvedLimit;
  /**
   * The unit of work's own id. A second draw under it — a retry, on any replica — adds nothing
   * while the key is remembered: the period it counted in and the next one.
   */
  readonly key: string;
}

export interface MeterDrawOutcome {
  /** The period's count after this draw, or after the draw `key` repeats. */
  readonly used: number;
  /** What `limit` resolved to for this call. */
  readonly limit: number;
  /** `true` when `key` had already counted, and this draw added nothing. */
  readonly replayed: boolean;
  /** When the period resets, ISO 8601 UTC. */
  readonly resetsAt: string;
}

const isAmount = (value: unknown): value is number => isMeterLimit(value) && value >= 1;

const isDrawKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_IDEMPOTENCY_KEY_LENGTH;

/**
 * Count `amount` against `meter` for this caller (`ctx`'s org, else actor), or throw
 * `X_METER_EXCEEDED` having counted nothing. The draw is the caller's whether or not its
 * transaction commits: the store writes outside it, and `key` is what makes a retry safe.
 */
export async function drawMeter(ctx: Ctx, input: MeterDrawInput): Promise<MeterDrawOutcome> {
  const name: unknown = input.meter;
  assertMeterCounter(name, input.period, 'draw');
  if (!isAmount(input.amount)) {
    throw new MeterInvalidError(name, 'amount', 'a whole number, 1 or more', input.amount, 'draw');
  }
  if (!isDrawKey(input.key)) {
    const expected = `a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} chars`;
    throw new MeterInvalidError(name, 'key', expected, input.key, 'draw');
  }
  const limit = await resolveMeterLimit(name, input.limit, ctx, 'draw');
  const nowMs = ctx.now().getTime();
  const window = meterWindow(input.period, nowMs);
  const drawn = await getMeterStore().draw({
    subject: meterSubject(ctx),
    meter: name,
    period: meterPeriodKey(input.period),
    periodStartMs: window.startMs,
    limit,
    amount: input.amount,
    drawKey: input.key,
  });
  if (!drawn.allowed) {
    throw new MeterExceededError({
      meter: name,
      period: input.period,
      limit,
      resetsAtMs: window.endMs,
      nowMs,
    });
  }
  return {
    used: drawn.used,
    limit,
    replayed: drawn.replayed === true,
    resetsAt: new Date(window.endMs).toISOString(),
  };
}
