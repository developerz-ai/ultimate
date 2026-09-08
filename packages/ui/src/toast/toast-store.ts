// The queue with a clock attached: auto-dismiss, and the three independent reasons it stops.
//
// Hover and focus-within are the two everybody implements. `document.hidden` is the one everybody
// forgets, and it is the one that loses the message outright: a backgrounded tab burns the whole
// dwell, so the user switches back to an empty corner and never learns the save failed. All three
// are HOLDS on one counter, because a pointer leaving while the tab is still hidden must not
// restart the countdown.

import { useId } from '../a11y';
import {
  addToast,
  advanceToasts,
  dismissToast,
  EMPTY_TOAST_QUEUE,
  nextExpiryMs,
  type ToastHold,
  type ToastInput,
  type ToastQueue,
  toastItem,
} from './toast-state';

/**
 * Every host capability the store touches, injected — the same shape `ThemeEnv` has and for the
 * same reason: a test drives the clock instead of waiting on it, and a server render gets an env
 * whose timers never fire rather than a store that throws.
 */
export interface ToastEnv {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => number;
  readonly clearTimer: (handle: number) => void;
  readonly isHidden: () => boolean;
  /** Subscribe to tab visibility; answers the unsubscribe. */
  readonly onVisibilityChange: (fn: () => void) => () => void;
}

/**
 * A server render has no tab to hide and no frame to wait for, so the honest env is one where
 * nothing is ever scheduled — not a stub of a browser, the same way `INERT_SOLID_RUNTIME` is not
 * a stub of a Solid runtime. A `<ToastRegion>` rendered against it emits its empty live region,
 * which is exactly what the document needs to carry BEFORE the first message arrives.
 */
export const INERT_TOAST_ENV: ToastEnv = Object.freeze({
  now: () => 0,
  setTimer: () => 0,
  clearTimer: () => undefined,
  isHidden: () => false,
  onVisibilityChange: () => () => undefined,
});

export function browserToastEnv(): ToastEnv {
  return {
    // `Date.now`, not `performance.now`: the dwell is wall-clock time a human is reading for, and
    // it is compared only against itself.
    now: () => Date.now(),
    setTimer: (fn, ms) => Number(setTimeout(fn, ms)),
    clearTimer: (handle) => {
      clearTimeout(handle);
    },
    isHidden: () => document.hidden,
    onVisibilityChange: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => {
        document.removeEventListener('visibilitychange', fn);
      };
    },
  };
}

export interface ToastStore {
  readonly queue: () => ToastQueue;
  /** Shows a toast, or refreshes the identical one already queued. Answers the live toast's id. */
  readonly show: (input: ToastInput) => string;
  readonly dismiss: (id: string) => void;
  /** Stop the countdown for one reason. Holds are independent — the last one released resumes. */
  readonly hold: (reason: ToastHold) => void;
  readonly release: (reason: ToastHold) => void;
  readonly subscribe: (listener: (queue: ToastQueue) => void) => () => void;
  /** Drop the timer and the visibility listener. Called from an island's `onCleanup`. */
  readonly stop: () => void;
}

/** A DOM is the whole question, exactly as `solid()` asks it. */
function defaultEnv(): ToastEnv {
  return typeof document === 'undefined' ? INERT_TOAST_ENV : browserToastEnv();
}

export function createToastStore(env: ToastEnv = defaultEnv()): ToastStore {
  const holds = new Set<ToastHold>();
  const listeners = new Set<(queue: ToastQueue) => void>();
  let queue: ToastQueue = EMPTY_TOAST_QUEUE;
  let timer: number | null = null;
  let lastAt = env.now();

  /** The ids on the list, which is the only change a renderer can see. */
  const shape = (): string => queue.items.map((item) => item.id).join(' ');

  /** Bank the time that has passed. While held, nothing is spent — only the clock is re-based. */
  const spend = (): void => {
    const now = env.now();
    if (holds.size === 0) queue = advanceToasts(queue, now - lastAt);
    lastAt = now;
  };

  const schedule = (): void => {
    if (timer !== null) {
      env.clearTimer(timer);
      timer = null;
    }
    if (holds.size > 0) return;
    const next = nextExpiryMs(queue);
    if (next === null) return;
    timer = env.setTimer(onDue, Math.max(next, 0));
  };

  const publish = (before: string): void => {
    if (shape() === before) return;
    for (const listener of [...listeners]) listener(queue);
  };

  function onDue(): void {
    timer = null;
    const before = shape();
    spend();
    publish(before);
    schedule();
  }

  const act = (change: () => void): void => {
    const before = shape();
    spend();
    change();
    publish(before);
    schedule();
  };

  const stopVisibility = env.onVisibilityChange(() => {
    if (env.isHidden()) act(() => holds.add('hidden'));
    else act(() => holds.delete('hidden'));
  });
  // A store created while the tab is ALREADY in the background starts held: the first
  // `visibilitychange` it hears is the one that brings the tab back, and by then the dwell is gone.
  if (env.isHidden()) holds.add('hidden');

  return {
    queue: () => queue,
    show: (input) => {
      let id = '';
      act(() => {
        const added = addToast(queue, toastItem(useId('toast'), input));
        queue = added.queue;
        id = added.id;
      });
      return id;
    },
    dismiss: (id) => {
      act(() => {
        queue = dismissToast(queue, id);
      });
    },
    hold: (reason) => {
      act(() => holds.add(reason));
    },
    release: (reason) => {
      act(() => holds.delete(reason));
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      if (timer !== null) env.clearTimer(timer);
      timer = null;
      stopVisibility();
      listeners.clear();
    },
  };
}
