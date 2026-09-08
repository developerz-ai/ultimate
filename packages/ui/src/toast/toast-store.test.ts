// The clock half, driven rather than waited on. The three pause reasons are the point: each one
// is a way a message gets destroyed before anybody reads it, and `document.hidden` is the one that
// destroys it silently — a backgrounded tab spends the whole dwell and the corner is empty when
// the user comes back.

import { describe, expect, test } from 'bun:test';
import { TOAST_DWELL_MS } from './toast-state';
import { createToastStore, INERT_TOAST_ENV, type ToastEnv } from './toast-store';

interface Clock {
  readonly env: ToastEnv;
  readonly advance: (ms: number) => void;
  readonly setHidden: (hidden: boolean) => void;
}

/** A clock a test owns: timers fire only when time is moved past them, in order. */
function fakeClock(startHidden = false): Clock {
  let now = 0;
  let hidden = startHidden;
  let nextHandle = 1;
  let listener: (() => void) | null = null;
  const timers = new Map<number, { at: number; fn: () => void }>();

  const env: ToastEnv = {
    now: () => now,
    setTimer: (fn, ms) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
    isHidden: () => hidden,
    onVisibilityChange: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };

  return {
    env,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    setHidden(value) {
      hidden = value;
      listener?.();
    },
  };
}

describe('createToastStore', () => {
  test('a toast dismisses itself on the dwell its token names', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    store.show({ message: 'Saved' });

    clock.advance(TOAST_DWELL_MS.short - 1);
    expect(store.queue().items).toHaveLength(1);
    clock.advance(1);
    expect(store.queue().items).toEqual([]);
  });

  test('a backgrounded tab does not burn the dwell — the message survives the switch away', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    store.show({ message: 'Upload failed' });

    clock.setHidden(true);
    clock.advance(60_000);
    // Without the visibilitychange hold this is an empty corner and a user who never learned.
    expect(store.queue().items).toHaveLength(1);

    clock.setHidden(false);
    clock.advance(TOAST_DWELL_MS.short);
    expect(store.queue().items).toEqual([]);
  });

  test('a store created while the tab is already hidden starts held', () => {
    const clock = fakeClock(true);
    const store = createToastStore(clock.env);
    store.show({ message: 'Saved' });
    // The first visibilitychange it will hear is the one bringing the tab BACK, so a store that
    // only listened would have spent the whole dwell before its first event.
    clock.advance(60_000);
    expect(store.queue().items).toHaveLength(1);
  });

  test('a pointer over the stack stops the countdown, and leaving resumes what was left', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    store.show({ message: 'Saved' });

    clock.advance(1_000);
    store.hold('pointer');
    clock.advance(60_000);
    expect(store.queue().items).toHaveLength(1);

    store.release('pointer');
    clock.advance(TOAST_DWELL_MS.short - 1_000 - 1);
    expect(store.queue().items).toHaveLength(1);
    clock.advance(1);
    expect(store.queue().items).toEqual([]);
  });

  test('the holds are independent — a pointer leaving a toast still focused keeps it', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    store.show({ message: 'Saved' });

    store.hold('pointer');
    store.hold('focus');
    store.release('pointer');
    clock.advance(60_000);
    // One boolean would have resumed here and expired the toast under the keyboard user reaching
    // for its undo.
    expect(store.queue().items).toHaveLength(1);

    store.release('focus');
    clock.advance(TOAST_DWELL_MS.short);
    expect(store.queue().items).toEqual([]);
  });

  test('a queued toast starts its dwell only when it surfaces', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    for (const message of ['one', 'two', 'three', 'four']) store.show({ message });

    clock.advance(TOAST_DWELL_MS.short);
    expect(store.queue().items.map((item) => item.message)).toEqual(['four']);
    clock.advance(TOAST_DWELL_MS.short - 1);
    expect(store.queue().items).toHaveLength(1);
    clock.advance(1);
    expect(store.queue().items).toEqual([]);
  });

  test('a duplicate answers the live toast’s id, so dismissing it dismisses the one on screen', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    const first = store.show({ message: 'Could not save' });
    const second = store.show({ message: 'Could not save' });

    expect(second).toBe(first);
    store.dismiss(second);
    expect(store.queue().items).toEqual([]);
  });

  test('a sticky toast waits for the reader, however long that is', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    const id = store.show({ message: 'You were signed out', dwell: 'sticky' });
    clock.advance(600_000);
    expect(store.queue().items).toHaveLength(1);
    store.dismiss(id);
    expect(store.queue().items).toEqual([]);
  });

  test('subscribers hear every change to the list, and nothing else', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    const seen: number[] = [];
    const unsubscribe = store.subscribe((queue) => seen.push(queue.items.length));

    store.show({ message: 'Saved' });
    clock.advance(TOAST_DWELL_MS.short);
    unsubscribe();
    store.show({ message: 'Another' });

    expect(seen).toEqual([1, 0]);
  });

  test('stop() drops the timer, so a torn-down island leaves nothing running', () => {
    const clock = fakeClock();
    const store = createToastStore(clock.env);
    const seen: number[] = [];
    store.subscribe((queue) => seen.push(queue.items.length));
    store.show({ message: 'Saved' });
    store.stop();

    clock.advance(60_000);
    expect(seen).toEqual([1]);
  });

  test('the inert env schedules nothing: a server render holds a store that cannot tick', () => {
    const store = createToastStore(INERT_TOAST_ENV);
    store.show({ message: 'Saved' });
    // No timer exists to fire, so the queue a server render walks is the one it was handed.
    expect(store.queue().items).toHaveLength(1);
  });
});
