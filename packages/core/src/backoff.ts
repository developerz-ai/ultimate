// Single responsibility: how long to wait before the next attempt. ONE curve-and-jitter function
// for the whole framework, because four packages shipped four of them — `@ultimat3/jobs`
// (equal jitter), `@ultimat3/ai` (full jitter, `Math.random` inline and so untestable),
// `@ultimat3/realtime` (full jitter, 0-based attempt) and `@ultimat3/db` (no backoff at all).

export type BackoffCurve = 'exponential' | 'linear' | 'fixed';

/**
 * `full` decorrelates a herd and is the only mode that does; `equal` keeps a latency floor for a
 * client that must not be starved; `none` is for tests, for a printable schedule, and for nothing
 * in production — a burst of failures retrying in lockstep is the thundering herd itself.
 */
export type JitterMode = 'full' | 'equal' | 'none';

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
  const step = Math.max(1, Math.trunc(options.attempt));
  const base = Math.max(0, options.base);
  const factor = options.factor ?? 2;

  let raw: number;
  if (options.curve === 'fixed') raw = base;
  else if (options.curve === 'linear') raw = base * step;
  else raw = base * factor ** (step - 1);

  const capped = Math.max(0, Math.min(raw, options.max));
  // A NaN reaches here from an unvalidated config value, and `setTimeout(NaN)` fires IMMEDIATELY —
  // a retry loop with no wait at all, which is the failure mode backoff exists to prevent. 0 is
  // wrong too, but it is wrong loudly: the next attempt still happens once, not in a tight spin.
  if (!Number.isFinite(capped)) return 0;

  const roll = options.random ?? Math.random;
  if (options.jitter === 'full') return Math.round(capped * roll());
  if (options.jitter === 'equal') return Math.round(capped / 2 + (capped / 2) * roll());
  return Math.round(capped);
}
