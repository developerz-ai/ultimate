/**
 * The bound on a navigation's wait for its answer. A fetch has no timeout of its own, and one that
 * never settles held the router's `inflight` forever: every later `refresh()` yielded to it.
 */

/** Longest a navigation waits for its answer — a held prefetch's included — before giving up. */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/** What the bound reads of the window: its timers, injected by the tests. */
type Timers = Pick<Window, 'setTimeout' | 'clearTimeout'>;

/**
 * `ask(signal)`, raced against the deadline. `signal` aborts with `mine` (a newer navigation) or at
 * the deadline, so the request is dropped either way; only a deadline REJECTS, with the abort's own
 * reason, and `mine` stays un-aborted — the caller fails it like any network failure, never silently.
 */
export function withinDeadline<T>(
  win: Timers,
  mine: AbortSignal,
  ask: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timed = new AbortController();
  let timer: number | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = win.setTimeout(() => {
      timed.abort();
      reject(timed.signal.reason);
    }, NAVIGATION_TIMEOUT_MS);
  });
  // The race, not the signal alone: a held prefetch the click reuses was fetched with no signal.
  // `ask` runs inside a promise so a synchronous throw rejects through the race, and its `finally`
  // clears the timer — thrown before it, `expired` would reject later with nobody listening.
  // (`Promise.try`, once the lib target types it.)
  const answer = new Promise<T>((resolve) => resolve(ask(AbortSignal.any([mine, timed.signal]))));
  return Promise.race([answer, expired]).finally(() => win.clearTimeout(timer));
}
