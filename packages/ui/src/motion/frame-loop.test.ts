// A frame loop stops for FOUR independent reasons — reduced motion, the reader's pause, a hidden
// tab, an element scrolled off screen — so its holds are a set, never a boolean: one reason
// clearing must not restart a loop another still holds.

import { describe, expect, test } from 'bun:test';
import { fakeFrames } from '../browser-fake-fixture';
import { type FrameHost, frameLoopOn } from './frame-loop';
import type { MotionHost } from './motion-gate';

function harness(start: { reduced?: boolean; paused?: boolean; hidden?: boolean } = {}) {
  const frames = fakeFrames();
  const state = { reduced: false, paused: false, hidden: false, ...start, now: 0 };
  const motionWatchers = new Set<() => void>();
  const visibilityWatchers = new Set<() => void>();
  let onscreen: ((visible: boolean) => void) | undefined;
  let observed = 0;
  const motion: MotionHost = {
    reduced: () => state.reduced,
    paused: () => state.paused,
    watch(fn) {
      motionWatchers.add(fn);
      return () => motionWatchers.delete(fn);
    },
  };
  const host: FrameHost = {
    request: frames.request,
    cancel: (id) => frames.cancel(id as number),
    now: () => state.now,
    hidden: () => state.hidden,
    onVisibility(fn) {
      visibilityWatchers.add(fn);
      return () => visibilityWatchers.delete(fn);
    },
    motion,
    observe(_el, fn) {
      observed += 1;
      onscreen = fn;
      return () => {
        observed -= 1;
        onscreen = undefined;
      };
    },
  };
  const ticks: number[] = [];
  const step = (ms = 16): void => {
    state.now += ms;
    frames.run();
  };
  return {
    host,
    ticks,
    frames,
    step,
    observed: () => observed,
    setMotion(next: { reduced?: boolean; paused?: boolean }) {
      Object.assign(state, next);
      for (const fn of motionWatchers) fn();
    },
    setHidden(hidden: boolean) {
      state.hidden = hidden;
      for (const fn of visibilityWatchers) fn();
    },
    setOnscreen: (visible: boolean) => onscreen?.(visible),
    tick: (dt: number) => ticks.push(dt),
  };
}

describe('frameLoop', () => {
  test('runs a frame at a time, handing each tick the time since the last', () => {
    const h = harness();
    frameLoopOn(h.host, h.tick);
    h.step(16);
    h.step(20);
    expect(h.ticks).toEqual([0, 20]);
    expect(h.frames.pending()).toBe(1);
  });

  for (const [reason, hold, release] of [
    [
      'reduced motion',
      (h: ReturnType<typeof harness>) => h.setMotion({ reduced: true }),
      (h: ReturnType<typeof harness>) => h.setMotion({ reduced: false }),
    ],
    [
      'the reader’s pause',
      (h: ReturnType<typeof harness>) => h.setMotion({ paused: true }),
      (h: ReturnType<typeof harness>) => h.setMotion({ paused: false }),
    ],
    [
      'a hidden tab',
      (h: ReturnType<typeof harness>) => h.setHidden(true),
      (h: ReturnType<typeof harness>) => h.setHidden(false),
    ],
    [
      'offscreen',
      (h: ReturnType<typeof harness>) => h.setOnscreen(false),
      (h: ReturnType<typeof harness>) => h.setOnscreen(true),
    ],
  ] as const) {
    test(`${reason} stops the loop, and its clearing restarts it with no jump in dt`, () => {
      const h = harness();
      frameLoopOn(h.host, h.tick, { el: {} as Element });
      h.setOnscreen(true);
      h.step();
      hold(h);
      expect(h.frames.pending()).toBe(0);
      h.step(5000);
      release(h);
      h.step(16);
      h.step(16);
      expect(h.ticks).toEqual([0, 0, 16]);
    });
  }

  test('one reason clearing while another holds does not restart it', () => {
    const h = harness();
    frameLoopOn(h.host, h.tick);
    h.setHidden(true);
    h.setMotion({ reduced: true });
    h.setHidden(false);
    expect(h.frames.pending()).toBe(0);
    h.setMotion({ reduced: false });
    expect(h.frames.pending()).toBe(1);
  });

  test('an element starts offscreen until the observer says otherwise', () => {
    const h = harness();
    frameLoopOn(h.host, h.tick, { el: {} as Element });
    expect(h.frames.pending()).toBe(0);
    h.setOnscreen(true);
    expect(h.frames.pending()).toBe(1);
  });

  test('a loop born under reduced motion never ticks', () => {
    const h = harness({ reduced: true });
    frameLoopOn(h.host, h.tick);
    h.step();
    expect(h.ticks).toEqual([]);
  });

  test('stop cancels the frame and every subscription, and is idempotent', () => {
    const h = harness();
    const stop = frameLoopOn(h.host, h.tick, { el: {} as Element });
    h.setOnscreen(true);
    stop();
    stop();
    expect(h.frames.pending()).toBe(0);
    expect(h.observed()).toBe(0);
    h.setHidden(false);
    h.setMotion({ reduced: false });
    expect(h.frames.pending()).toBe(0);
  });

  test('off the DOM there is no host, and the loop is a no-op stop', () => {
    expect(frameLoopOn(null, h0)).toBeInstanceOf(Function);
  });
});

function h0(): void {}
