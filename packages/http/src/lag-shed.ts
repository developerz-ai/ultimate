// Single responsibility: shedding on event-loop lag (`http.shedLagMs`) — the overload a static
// in-flight ceiling cannot see, because CPU-bound SSR saturates the loop with few requests in
// flight. A sampler measures how late a short timer fires; the `admit` stage compares one number
// per request. Off by default in 31.x (owner decision OD1): nothing here runs until an app opts in.

import { type Clock, systemClock } from '@ultimat3/core';
import { HttpError } from './errors';

/** How often the loop is asked how late it is: fine enough that a 100 ms stall is several samples. */
export const LAG_SAMPLE_MS = 20;

/** Samples in the window — two seconds at `LAG_SAMPLE_MS`, so the verdict outlives one GC pause. */
export const LAG_WINDOW = 100;

export interface LagSamplerOptions {
  readonly clock?: Clock | undefined;
  /** The timer. Injected by a test; the default is an unref'd `setInterval`. */
  readonly every?: ((tick: () => void, intervalMs: number) => () => void) | undefined;
}

export interface LagSampler {
  /** p99 of the window's samples, in milliseconds — `0` until the first sample. */
  p99Ms(): number;
  stop(): void;
}

const unrefInterval = (tick: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * The p99 is recomputed on the TICK (fifty a second, a hundred numbers each), never on the request
 * path: `admit` reads a number. With a full window the p99 is the second-worst sample, so a single
 * stall does not shed and a loop that stays late does.
 */
export function lagSampler(options: LagSamplerOptions = {}): LagSampler {
  const clock = options.clock ?? systemClock;
  const samples = new Float64Array(LAG_WINDOW);
  const sorted = new Float64Array(LAG_WINDOW);
  let filled = 0;
  let next = 0;
  let p99 = 0;
  let due = clock.monotonic() + LAG_SAMPLE_MS;
  const stop = (options.every ?? unrefInterval)(() => {
    const now = clock.monotonic();
    samples[next] = Math.max(0, now - due);
    next = (next + 1) % LAG_WINDOW;
    filled = Math.min(filled + 1, LAG_WINDOW);
    due = now + LAG_SAMPLE_MS;
    const view = sorted.subarray(0, filled);
    view.set(samples.subarray(0, filled));
    view.sort();
    p99 = view[Math.ceil(filled * 0.99) - 1] ?? 0;
  }, LAG_SAMPLE_MS);
  return { p99Ms: () => p99, stop };
}

/** The process's one sampler, started by the first pipeline that declares `shedLagMs`. */
let shared: LagSampler | undefined;

export const processLagSampler = (): LagSampler => {
  shared ??= lagSampler();
  return shared;
};

/** TEST SEAM: stop the process sampler so a suite leaves no timer behind. */
export const stopProcessLagSampler = (): void => {
  shared?.stop();
  shared = undefined;
};

/** `X_OVERLOADED`, borrowed with its 503: the same refusal `maxInflight` makes, for the loop's reason. */
export const overloadedByLag = (lagMs: number, ceilingMs: number): HttpError =>
  new HttpError({
    code: 'X_OVERLOADED',
    cause: `the event loop's lag p99 is ${String(Math.round(lagMs))}ms and http.shedLagMs is ${String(ceilingMs)}: this process is CPU-bound, and a request admitted now waits behind every one already running`,
    fix: 'retry after the Retry-After header; to shed later call configureHttp({ shedLagMs: 500 }) at module scope in a file under apps/*/, or add replicas so each one renders less',
  });
