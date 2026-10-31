// One request's signal: a deadline plus the caller's own signal, undone when the request settles.
// `AbortSignal.any([AbortSignal.timeout(ms), outer])` composed the same thing and could not be
// undone — every read hung one listener (and one composite) on a session-long `outer` and armed a
// timer that outlived the answer. The shape is `@ultimat3/jobs`' `createRunSignal`.

import { type DeadlineTimer, platformDeadlineTimer } from './clock';

export type { DeadlineTimer } from './clock';

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
