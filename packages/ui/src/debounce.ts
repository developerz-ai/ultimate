// Trailing-edge debounce: the last call of a burst wins, `ms` after the burst stops.
// One timer, always cancellable — a component that unmounts mid-burst must not fire
// a filter into a tree that is gone, which is what a leaked timer does.

import { invalidValueError } from './errors';

export interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  /** Drop the pending call. Wire it to the component's cleanup. */
  cancel(): void;
  /** Run the pending call now, if there is one. Blur and submit both need this. */
  flush(): void;
  /** True while a call is waiting. */
  pending(): boolean;
}

export const DEBOUNCE_DEFAULT_MS = 250;

export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number = DEBOUNCE_DEFAULT_MS,
): Debounced<A> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw invalidValueError('debounce', ms, 'a finite, non-negative delay in milliseconds');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued: A | undefined;

  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    queued = undefined;
  };

  const run = (): void => {
    const args = queued;
    // Cleared BEFORE the call: `fn` may schedule the next burst, and clearing after would
    // discard the call it just queued.
    cancel();
    if (args !== undefined) fn(...args);
  };

  const debounced = (...args: A): void => {
    queued = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  return Object.assign(debounced, {
    cancel,
    flush: run,
    pending: (): boolean => timer !== undefined,
  });
}
