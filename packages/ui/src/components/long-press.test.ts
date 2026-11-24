// A held finger ticks a card: the press fires once the timer runs, never after travel or a lift,
// and the click the lift sends is the one the binder swallows. The timer is a plain queue here.

import { describe, expect, test } from 'bun:test';
import { DRAG_THRESHOLD_PX } from '../drag/pointer-drag';
import { LONG_PRESS_MS, longPress } from './long-press';

function harness() {
  const pending: { fn: () => void; ms: number; live: boolean }[] = [];
  let fired = 0;
  const press = longPress(
    () => {
      fired += 1;
    },
    (fn, ms) => {
      const entry = { fn, ms, live: true };
      pending.push(entry);
      return () => {
        entry.live = false;
      };
    },
  );
  const elapse = (): void => {
    for (const entry of pending.splice(0)) if (entry.live) entry.fn();
  };
  return { press, elapse, fired: () => fired, pending };
}

describe('longPress', () => {
  test('a finger held still fires once, at the platform delay', () => {
    const h = harness();
    h.press.down({ x: 10, y: 10 });
    expect(h.pending[0]?.ms).toBe(LONG_PRESS_MS);
    h.press.move({ x: 11, y: 10 });
    h.elapse();
    expect(h.fired()).toBe(1);
    expect(h.press.fired()).toBe(true);
  });

  test('a lift before the delay is a tap: nothing fires', () => {
    const h = harness();
    h.press.down({ x: 0, y: 0 });
    h.press.up();
    h.elapse();
    expect(h.fired()).toBe(0);
    expect(h.press.fired()).toBe(false);
  });

  test('travel past the drag threshold is a scroll, never a long press', () => {
    const h = harness();
    h.press.down({ x: 0, y: 0 });
    h.press.move({ x: 0, y: DRAG_THRESHOLD_PX });
    h.elapse();
    expect(h.fired()).toBe(0);
  });

  test('a later press of another kind forgets the fired one, so its click is not swallowed', () => {
    const h = harness();
    h.press.down({ x: 0, y: 0 });
    h.elapse();
    h.press.reset();
    expect(h.press.fired()).toBe(false);
  });
});
