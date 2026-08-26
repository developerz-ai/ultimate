// Single responsibility: how long to wait before the next attempt. ONE curve-and-jitter function
// for the whole framework, because four packages shipped four of them — `@ultimat3/jobs`
// (equal jitter), `@ultimat3/ai` (full jitter, `Math.random` inline and so untestable),
// `@ultimat3/realtime` (full jitter, 0-based attempt) and `@ultimat3/db` (no backoff at all).

import { finiteOption } from './finite-option';

export type BackoffCurve = 'exponential' | 'linear' | 'fixed';

/**
 * `full` decorrelates a herd and is the only mode that does; `equal` keeps a latency floor for a
 * client that must not be starved; `none` is for tests, for a printable schedule, and for nothing
 * in production — a burst of failures retrying in lockstep is the thundering herd itself.
 */
export type JitterMode = 'full' | 'equal' | 'none';

/** Named in every refusal below, so a reader knows which call built the schedule. */
const SUBJECT = 'backoffDelay';

/** Injected everywhere. A delay only provable by observing a range is a delay no test pins. */
export type Random = () => number;

export interface BackoffOptions {
  /** 1-BASED: the wait after the first failure is `attempt: 1`. Below 1 is clamped to 1. */
  readonly attempt: number;
  /** The first delay, in ms. */
  readonly base: number;
  /** Ceiling for any single delay, in ms. Applied BEFORE jitter, never after. */
  readonly max: number;
  /** Default 2, and read by `exponential` only. */
  readonly factor?: number | undefined;
  readonly curve?: BackoffCurve | undefined;
  /** Default `none`, so a caller that says nothing gets a schedule it can predict. */
  readonly jitter?: JitterMode | undefined;
  readonly random?: Random | undefined;
}

/**
 * Milliseconds to wait before `attempt`, rounded to a whole ms and never negative.
 *
 * The clamp lands before the jitter deliberately: jittering first and capping after turns `full`
 * into a distribution whose upper half is a single value at `max`, which is the correlation the
 * jitter exists to remove.
 */
export function backoffDelay(options: BackoffOptions): number {
  // Every bound is REFUSED before it is clamped, because the clamps are not validators: measured,
  // `retry({ attempts: 5, max: NaN })` slept `[0, 0, 0, 0]` and `factor: NaN` slept
  // `[1000, 0, 0, 0]` — `Math.max`, `Math.min` and `Math.trunc` each propagate it,
  // `Math.min(raw, Infinity)` is `Infinity`, and the `return 0` below then turns the whole
  // schedule into a spin.
  const step = Math.max(1, Math.trunc(finiteOption(SUBJECT, 'attempt', options.attempt)));
  const base = Math.max(0, finiteOption(SUBJECT, 'base', options.base));
  const max = finiteOption(SUBJECT, 'max', options.max);
  const factor = finiteOption(SUBJECT, 'factor', options.factor ?? 2);

  let raw: number;
  if (options.curve === 'fixed') raw = base;
  else if (options.curve === 'linear') raw = base * step;
  else raw = base * factor ** (step - 1);

  const capped = Math.max(0, Math.min(raw, max));
  // Still reachable with four finite inputs, and only one way: `factor ** (step - 1)` overflows to
  // `Infinity` around attempt 1030, and `0 * Infinity` is `NaN`. A zero base is a caller asking
  // for no wait, so 0 is the answer it asked for — it is no longer the answer an unvalidated
  // config value gets, which is what this line used to be.
  if (!Number.isFinite(capped)) return 0;

  const roll = options.random ?? Math.random;
  if (options.jitter === 'full') return Math.round(capped * roll());
  if (options.jitter === 'equal') return Math.round(capped / 2 + (capped / 2) * roll());
  return Math.round(capped);
}
