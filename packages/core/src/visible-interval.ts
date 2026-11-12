/**
 * A poll that a hidden tab and a lost session both stop: the ONE timer for what has no changefeed,
 * and for the safety re-read behind an at-most-once channel. Here, not in `@ultimat3/realtime`,
 * because reaching realtime ships the whole page runtime to an island that only wanted a timer.
 */

import { backoffDelay, type Random } from './backoff';
import { finiteOption, MAX_TIMER_MS } from './finite-option';
import { whileSessionHeld } from './session-lost';

export interface VisibleIntervalOptions {
  /**
   * Back off on failure: each failed run (a throw or a rejection) doubles the wait from `ms` up to
   * `maxMs`, with equal jitter so a fleet of tabs does not ask in lockstep; a success resets it to
   * `ms`. Default `8 × ms`; `maxMs: ms` opts out, and every wait is `ms`, failed or not.
   */
  readonly maxMs?: number | undefined;
}

/** The tab, injected: timers and visibility. Internal; `visibleInterval` reads the real one. */
export interface IntervalHost {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  isHidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibility(fn: () => void): () => void;
  readonly random: Random;
}

const SUBJECT = 'visibleInterval';

/**
 * The default failure ceiling, as a multiple of `ms`. A default of `ms` itself (no back-off unless
 * asked) meant every open tab polled a failing endpoint at its full healthy rate, which is the
 * load a partial outage least needs; 8 is three doublings, so a recovery is seen within `8 × ms`.
 */
const FAILURE_BACKOFF_FACTOR = 8;

/**
 * Call `run` every `ms` while the tab is shown. Hidden: no call; one make-up call when shown. An
 * async `run` is never overlapped — the next wait starts when it settles; a throw or rejection is
 * re-raised for the page's error hook. Failures back off to `maxMs` (default `8 × ms`); a
 * success resets. Stops on a session loss; starts afresh when a principal next signs in. Returns
 * an idempotent disposer.
 */
export function visibleInterval(
  run: () => unknown,
  ms: number,
  options: VisibleIntervalOptions = {},
): () => void {
  return visibleIntervalOn(browserHost(), run, ms, options);
}

/** `visibleInterval` over an injected tab. Internal: tests and `visibleInterval` call it. */
export function visibleIntervalOn(
  host: IntervalHost,
  run: () => unknown,
  ms: number,
  options: VisibleIntervalOptions = {},
): () => void {
  const base = clampTimer(finiteOption(SUBJECT, 'ms', ms));
  const max = clampTimer(
    options.maxMs === undefined
      ? base * FAILURE_BACKOFF_FACTOR
      : finiteOption(SUBJECT, 'maxMs', options.maxMs),
  );
  // Stopped by a session loss, started afresh — attempt 1 — by the next signed-in principal.
  return whileSessionHeld(() => runLoop(host, run, base, max));
}

/** One session's loop: armed now, stopped by the returned function. */
function runLoop(host: IntervalHost, run: () => unknown, base: number, max: number): () => void {
  /** 1 + the failures since the last success: what `backoffDelay` grows the wait by. */
  let attempt = 1;
  let timer: unknown;
  let owed = false;
  let running = false;
  let stopped = false;

  const arm = (): void => {
    if (stopped || running) return;
    // Jitter spreads a fleet's RETRIES; a healthy poll's period is exactly what was asked for.
    const wait =
      attempt > 1 && max > base
        ? backoffDelay({ attempt, base, max, jitter: 'equal', random: host.random })
        : base;
    timer = host.setTimer(tick, wait);
  };
  const call = (): void => {
    running = true;
    const settled = (failed: boolean): void => {
      running = false;
      attempt = failed ? attempt + 1 : 1;
      arm();
    };
    // A failure is timed (it backs off) and then re-raised ONCE, off the loop's stack, so the loop
    // survives and the page's error hook still sees what `run` did not catch. Never swallowed.
    const failed = (error: unknown): void => {
      settled(true);
      queueMicrotask(() => {
        throw error;
      });
    };
    let result: unknown;
    try {
      result = run();
    } catch (error) {
      failed(error);
      return;
    }
    if (result instanceof Promise) result.then(() => settled(false), failed);
    else settled(false);
  };
  const tick = (): void => {
    timer = undefined;
    if (host.isHidden()) {
      owed = true;
      return;
    }
    call();
  };
  const visible = (): void => {
    if (host.isHidden() || !owed) return;
    owed = false;
    call();
  };

  const offVisibility = host.onVisibility(visible);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) host.clearTimer(timer);
    timer = undefined;
    offVisibility();
  };
  arm();
  return stop;
}

/** A timer past 2^31-1 ms fires at once, and one under 1 ms is a spin. */
function clampTimer(ms: number): number {
  return Math.min(Math.max(1, ms), MAX_TIMER_MS);
}

type VisibilityDoc = {
  readonly visibilityState?: string;
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
};

function browserHost(): IntervalHost {
  const doc: VisibilityDoc | undefined = Reflect.get(globalThis, 'document');
  return {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    isHidden: () => doc?.visibilityState === 'hidden',
    onVisibility(fn) {
      doc?.addEventListener?.('visibilitychange', fn);
      return (): void => doc?.removeEventListener?.('visibilitychange', fn);
    },
    random: Math.random,
  };
}
