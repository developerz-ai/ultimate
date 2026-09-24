// The sentinel's decision, apart from the observer. IntersectionObserver fires on a CHANGE of
// intersection, so a page too short to push the sentinel out of view left it visible when
// `loading` went false — no new callback came, and the list stalled with the runway still showing.

import { describe, expect, test } from 'bun:test';
import { createLoadMoreTrigger } from './load-more-trigger';

describe('createLoadMoreTrigger', () => {
  const counted = () => {
    let calls = 0;
    return { calls: () => calls, onLoadMore: () => (calls += 1) };
  };

  test('the sentinel appearing while idle asks for the next page', () => {
    const { calls, onLoadMore } = counted();
    const trigger = createLoadMoreTrigger(onLoadMore);
    trigger.seen(true, false);
    expect(calls()).toBe(1);
  });

  test('a sentinel still in view when loading settles asks again', () => {
    const { calls, onLoadMore } = counted();
    const trigger = createLoadMoreTrigger(onLoadMore);
    trigger.seen(true, false);
    trigger.settled(true);
    trigger.settled(false);
    expect(calls()).toBe(2);
  });

  test('a sentinel that scrolled away does not', () => {
    const { calls, onLoadMore } = counted();
    const trigger = createLoadMoreTrigger(onLoadMore);
    trigger.seen(true, false);
    trigger.seen(false, true);
    trigger.settled(false);
    expect(calls()).toBe(1);
  });

  test('never while a page is in flight', () => {
    const { calls, onLoadMore } = counted();
    const trigger = createLoadMoreTrigger(onLoadMore);
    trigger.seen(true, true);
    expect(calls()).toBe(0);
    trigger.settled(false);
    expect(calls()).toBe(1);
  });
});
