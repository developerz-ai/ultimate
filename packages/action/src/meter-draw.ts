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
  /** Units this draw adds: a positive safe integer (1 to `Number.MAX_SAFE_INTEGER`). */
  readonly amount: number;
  /** Units allowed per period, or resolved per call from `{ ctx }` — the tenant's plan. */
  readonly limit: ResolvedLimit;
  /**
   * The unit of work's own id, 1–255 chars with no NUL. A second draw under it — a retry, on any
   * replica sharing one store — adds nothing while the key is remembered: the period it counted in
   * and the next one. `memoryMeterStore()` remembers per process and up to its `maxDrawKeys`; the
   * Postgres store the boot installs remembers across replicas and restarts.
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

/** No NUL: Postgres `text` cannot hold one, so the shared store could never remember the key. */
const isDrawKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
  !value.includes('\u0000');

/**
 * Count `amount` against `meter` for this caller (`ctx`'s org, else actor), or throw
 * `X_METER_EXCEEDED` having counted nothing. The draw is the caller's whether or not its
 * transaction commits: the store writes outside it, and `key` is what makes a retry safe.
 */
export async function drawMeter(ctx: Ctx, input: MeterDrawInput): Promise<MeterDrawOutcome> {
  // Read once, before anything awaits: a limit resolver holding the input cannot change what was
  // validated after the fact.
  const { meter, period, amount, key, limit: declared } = input;
  const name: unknown = meter;
  assertMeterCounter(name, period, 'draw');
  if (!isAmount(amount)) {
    throw new MeterInvalidError(name, 'amount', 'a positive safe integer', amount, 'draw');
  }
  if (!isDrawKey(key)) {
    const expected = `a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} chars, with no NUL`;
    throw new MeterInvalidError(name, 'key', expected, key, 'draw');
  }
  const store = getMeterStore();
  if (store.keyedDraws !== true) {
    throw new MeterInvalidError(
      name,
      'store',
      'a MeterStore declaring keyedDraws: true — one that adds amount and remembers drawKey',
      undefined,
      'draw',
    );
  }
  const limit = await resolveMeterLimit(name, declared, ctx, 'draw');
  const nowMs = ctx.now().getTime();
  const window = meterWindow(period, nowMs);
  const drawn = await store.draw({
    subject: meterSubject(ctx),
    meter: name,
    period: meterPeriodKey(period),
    periodStartMs: window.startMs,
    limit,
    amount,
    drawKey: key,
  });
  // A lagging replica's draw lands on a counter already in the next period: its reset is that one's.
  const resetsAtMs =
    drawn.periodStartMs === undefined || drawn.periodStartMs <= window.startMs
      ? window.endMs
      : meterWindow(period, drawn.periodStartMs).endMs;
  if (!drawn.allowed) {
    throw new MeterExceededError({
      meter: name,
      period,
      limit,
      resetsAtMs,
      nowMs,
      ...(amount > limit ? { amount } : {}),
    });
  }
  return {
    used: drawn.used,
    limit,
    replayed: drawn.replayed === true,
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}
