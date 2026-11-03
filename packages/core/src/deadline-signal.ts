// One request's signal: a deadline plus the caller's own signal, undone when the request settles.
// `AbortSignal.any([AbortSignal.timeout(ms), outer])` could not be undone: every read hung one
// listener on a session-long `outer` and armed a timer that outlived the answer. In core since
// `outbound()` arms one per attempt; `@ultimat3/scraping` imports it from `@ultimat3/core/outbound`.

/**
 * The timer a request DEADLINE is armed on — not a wait, but a timer all the same, so a test hands
 * its own and fires it rather than waiting. Cleared when the request settles, where
 * `AbortSignal.timeout` stayed armed for its whole span after the answer had landed.
 */
export interface DeadlineTimer {
  set(fire: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const platformDeadlineTimer: DeadlineTimer = Object.freeze({
  set: (fire: () => void, ms: number): unknown => setTimeout(fire, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export interface DeadlineSignal extends Disposable {
  /** Aborts at the deadline (a `TimeoutError`, as `AbortSignal.timeout`'s) or with `outer`. */
  readonly signal: AbortSignal;
  /** Whether the DEADLINE fired — not the caller cancelling. What the timeout code is chosen by. */
  timedOut(): boolean;
}

/**
 * `ms` is the caller's already-screened deadline (a positive finite count). `[Symbol.dispose]`
 * clears the timer and detaches from `outer`; idempotent, and it never aborts.
 */
export function deadlineSignal(
  ms: number,
  outer?: AbortSignal,
  timer: DeadlineTimer = platformDeadlineTimer,
): DeadlineSignal {
  const controller = new AbortController();
  let fired = false;
  const handle = timer.set(() => {
    fired = true;
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }, ms);
  const forward = (): void => controller.abort(outer?.reason);
  if (outer?.aborted === true) forward();
  else outer?.addEventListener('abort', forward, { once: true });
  let open = true;
  return {
    signal: controller.signal,
    timedOut: () => fired,
    [Symbol.dispose]: () => {
      if (!open) return;
      open = false;
      timer.clear(handle);
      outer?.removeEventListener('abort', forward);
    },
  };
}
