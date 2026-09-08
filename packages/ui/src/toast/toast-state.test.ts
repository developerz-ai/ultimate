// The queue's rules with no clock: what a duplicate does, what the cap does, and which toasts a
// tick is allowed to spend. Every failure here is a message the user never reads.

import { describe, expect, test } from 'bun:test';
import {
  addToast,
  advanceToasts,
  collapsedToasts,
  dismissToast,
  EMPTY_TOAST_QUEUE,
  nextExpiryMs,
  TOAST_DWELL_MS,
  TOAST_MAX_VISIBLE,
  type ToastInput,
  type ToastQueue,
  toastItem,
  visibleToasts,
} from './toast-state';

const push = (queue: ToastQueue, id: string, input: ToastInput): ToastQueue =>
  addToast(queue, toastItem(id, input)).queue;

const queueOf = (...messages: readonly string[]): ToastQueue =>
  messages.reduce(
    (queue, message, index) => push(queue, `t${index}`, { message }),
    EMPTY_TOAST_QUEUE,
  );

describe('addToast', () => {
  test('a repeated identical message refreshes the live toast instead of stacking a second', () => {
    // A retry loop firing the same failure every 800ms filled the corner with one sentence.
    const first = addToast(EMPTY_TOAST_QUEUE, toastItem('a', { message: 'Could not save' }));
    const spent = advanceToasts(first.queue, 3_000);
    const again = addToast(spent, toastItem('b', { message: 'Could not save' }));

    expect(again.queue.items).toHaveLength(1);
    expect(again.id).toBe('a');
    expect(again.queue.items[0]?.remainingMs).toBe(TOAST_DWELL_MS.short);
  });

  test('the refreshed toast keeps its place — a repeating error does not walk up the stack', () => {
    const queue = push(push(queueOf(), 'x', { message: 'first' }), 'y', { message: 'second' });
    const refreshed = addToast(queue, toastItem('z', { message: 'first' })).queue;
    expect(refreshed.items.map((item) => item.id)).toEqual(['x', 'y']);
  });

  test('a different tone or title is a different message', () => {
    const queue = push(queueOf(), 'a', { message: 'Saved' });
    expect(push(queue, 'b', { message: 'Saved', tone: 'danger' }).items).toHaveLength(2);
    expect(push(queue, 'c', { message: 'Saved', title: 'Draft' }).items).toHaveLength(2);
  });
});

describe('the visible cap', () => {
  const many = queueOf('one', 'two', 'three', 'four', 'five');

  test('shows the oldest and queues the rest', () => {
    expect(visibleToasts(many)).toHaveLength(TOAST_MAX_VISIBLE);
    expect(collapsedToasts(many).map((item) => item.message)).toEqual(['four', 'five']);
  });

  test('a queued toast does not spend its dwell — nobody has read it yet', () => {
    const spent = advanceToasts(many, TOAST_DWELL_MS.short);
    // The three on screen expired; the two behind them still hold a full dwell.
    expect(spent.items.map((item) => item.message)).toEqual(['four', 'five']);
    expect(spent.items.map((item) => item.remainingMs)).toEqual([
      TOAST_DWELL_MS.short,
      TOAST_DWELL_MS.short,
    ]);
  });

  test('nextExpiryMs reads the visible slice only', () => {
    const uneven = advanceToasts(many, 1_000);
    expect(nextExpiryMs(uneven)).toBe(TOAST_DWELL_MS.short - 1_000);
  });
});

describe('advanceToasts', () => {
  test('a sticky toast never counts down, however long it is left', () => {
    const queue = push(queueOf(), 's', { message: 'Signed out', dwell: 'sticky' });
    expect(advanceToasts(queue, 60_000).items).toHaveLength(1);
    expect(nextExpiryMs(queue)).toBeNull();
  });

  test('a long toast outlives a short one', () => {
    const queue = push(push(queueOf(), 'a', { message: 'a' }), 'b', {
      message: 'b',
      dwell: 'long',
    });
    expect(advanceToasts(queue, TOAST_DWELL_MS.short).items.map((item) => item.id)).toEqual(['b']);
  });

  test('no elapsed time is no change at all, by identity', () => {
    const queue = queueOf('one');
    expect(advanceToasts(queue, 0)).toBe(queue);
    expect(advanceToasts(queue, Number.NaN)).toBe(queue);
  });

  test('an empty queue has nothing to schedule', () => {
    expect(nextExpiryMs(EMPTY_TOAST_QUEUE)).toBeNull();
    expect(visibleToasts(EMPTY_TOAST_QUEUE)).toEqual([]);
  });
});

describe('dismissToast', () => {
  test('removes the one named and answers the same queue for one it does not hold', () => {
    const queue = queueOf('one', 'two');
    expect(dismissToast(queue, 't0').items.map((item) => item.message)).toEqual(['two']);
    expect(dismissToast(queue, 'nope')).toBe(queue);
  });
});
