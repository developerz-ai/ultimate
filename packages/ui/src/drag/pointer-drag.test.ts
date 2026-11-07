// The gesture's state machine and the edge scroller, driven with plain points and a fake frame
// clock: a tap never lifts, every cancel restores, and reduced motion steps instead of gliding.

import { describe, expect, test } from 'bun:test';
import {
  AUTO_SCROLL_EDGE_PX,
  AUTO_SCROLL_MAX_PX,
  autoScrollDelta,
  autoScroller,
  DRAG_THRESHOLD_PX,
  type DragHandlers,
  dragTracker,
  REDUCED_STEP_MS,
  type ScrollEnv,
} from './pointer-drag';

const recorder = (): { calls: string[]; handlers: DragHandlers } => {
  const calls: string[] = [];
  return {
    calls,
    handlers: {
      start: (p) => calls.push(`start ${p.x},${p.y}`),
      move: (p) => calls.push(`move ${p.x},${p.y}`),
      drop: (p) => calls.push(`drop ${p.x},${p.y}`),
      cancel: () => calls.push('cancel'),
    },
  };
};

describe('dragTracker', () => {
  test('a press that travels less than the threshold is a tap: nothing lifts or drops', () => {
    const { calls, handlers } = recorder();
    const drag = dragTracker(handlers);
    drag.down({ x: 0, y: 0 });
    drag.move({ x: DRAG_THRESHOLD_PX - 1, y: 0 });
    drag.up({ x: DRAG_THRESHOLD_PX - 1, y: 0 });
    expect(calls).toEqual([]);
    expect(drag.phase()).toBe('idle');
  });

  test('past the threshold it lifts at the origin, follows, and drops once', () => {
    const { calls, handlers } = recorder();
    const drag = dragTracker(handlers);
    drag.down({ x: 0, y: 0 });
    drag.move({ x: 0, y: 10 });
    drag.up({ x: 0, y: 12 });
    expect(calls).toEqual(['start 0,0', 'move 0,10', 'drop 0,12']);
  });

  test('a cancel mid-drag restores and a later release requests nothing', () => {
    const { calls, handlers } = recorder();
    const drag = dragTracker(handlers);
    drag.down({ x: 0, y: 0 });
    drag.move({ x: 0, y: 10 });
    drag.cancel();
    drag.up({ x: 0, y: 30 });
    expect(calls).toEqual(['start 0,0', 'move 0,10', 'cancel']);
    expect(drag.phase()).toBe('idle');
  });

  test('a cancel with no drag in flight says nothing', () => {
    const { calls, handlers } = recorder();
    const drag = dragTracker(handlers);
    drag.down({ x: 0, y: 0 });
    drag.cancel();
    expect(calls).toEqual([]);
  });
});

describe('autoScrollDelta', () => {
  test('zero in the middle, signed near each edge, capped at the edge', () => {
    expect(autoScrollDelta(500, 0, 1000, false)).toBe(0);
    expect(autoScrollDelta(990, 0, 1000, false)).toBeGreaterThan(0);
    expect(autoScrollDelta(10, 0, 1000, false)).toBeLessThan(0);
    expect(autoScrollDelta(-500, 0, 1000, false)).toBe(-AUTO_SCROLL_MAX_PX);
  });

  test('reduced motion has no ramp: one whole step', () => {
    expect(autoScrollDelta(990, 0, 1000, true)).toBe(AUTO_SCROLL_EDGE_PX);
  });
});

describe('autoScroller', () => {
  const fakeEnv = (reduced: boolean) => {
    const queue: (() => void)[] = [];
    let clock = 0;
    const env: ScrollEnv = {
      frame: (run) => queue.push(run),
      cancelFrame: () => queue.splice(0),
      now: () => clock,
      reducedMotion: () => reduced,
    };
    const step = (ms: number): void => {
      clock += ms;
      queue.shift()?.();
    };
    return { env, step, queue };
  };
  const box = () => {
    const scrolled: number[] = [];
    return {
      scrolled,
      getBoundingClientRect: () => ({ top: 0, bottom: 1000, left: 0, right: 300 }),
      scrollBy: (_x: number, y: number) => scrolled.push(y),
    };
  };

  test('scrolls every frame near an edge and stops when told', () => {
    const { env, step, queue } = fakeEnv(false);
    const target = box();
    const scroller = autoScroller(env, target);
    scroller.update({ x: 150, y: 995 });
    step(16);
    step(16);
    expect(target.scrolled.length).toBe(2);
    scroller.stop();
    expect(queue.length).toBe(0);
  });

  test('under reduced motion it steps at most once per REDUCED_STEP_MS', () => {
    const { env, step } = fakeEnv(true);
    const target = box();
    autoScroller(env, target).update({ x: 150, y: 995 });
    for (let i = 0; i < 10; i += 1) step(16);
    expect(target.scrolled).toEqual([AUTO_SCROLL_EDGE_PX]);
    step(REDUCED_STEP_MS);
    expect(target.scrolled.length).toBe(2);
  });
});
