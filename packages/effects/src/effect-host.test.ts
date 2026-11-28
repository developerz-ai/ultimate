// `browserHost()` and `browserMotion()` over a minimal page: the real observers' wiring (resize,
// on-screen, hidden tab, theme) and the motion port delegating to `@ultimat3/ui/motion`'s own
// `frameLoop` / `motionAllowed` / `onMotionChange` — the code an island actually runs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { browserHost } from './effect-host';
import { browserMotion } from './motion-port';
import { type FakePage, installFakePage } from './mount-harness-fixture';

let page: FakePage;
beforeEach(() => {
  page = installFakePage();
});
afterEach(() => page.restore());

const element = (): Element =>
  ({ getBoundingClientRect: () => ({ width: 120, height: 80 }) }) as unknown as Element;

describe('unit · browserHost', () => {
  test('observeSize answers the box now and on each resize report', () => {
    const sizes: (readonly [number, number])[] = [];
    const stop = browserHost().observeSize(element(), (w, h) => sizes.push([w, h]));
    // The fake ResizeObserver reports on observe (400x300); the box read answers 120x80.
    expect(sizes).toEqual([
      [400, 300],
      [120, 80],
    ]);
    stop();
  });

  test('observeVisible is on screen AND a visible tab, through ui.inView', () => {
    const seen: boolean[] = [];
    const stop = browserHost().observeVisible(element(), (visible) => seen.push(visible));
    expect(seen.at(-1)).toBe(true);
    page.setHidden(true);
    expect(seen.at(-1)).toBe(false);
    page.setHidden(false);
    expect(seen.at(-1)).toBe(true);
    stop();
    page.setHidden(true);
    expect(seen.at(-1)).toBe(true);
  });

  test('observeTheme subscribes to the theme attribute and the OS scheme, and stops', () => {
    let changes = 0;
    const stop = browserHost().observeTheme(() => changes++);
    // The fake MutationObserver reports once on observe: the wiring reached the callback.
    expect(changes).toBe(1);
    stop();
  });

  test('readVar answers the resolved, trimmed custom property', () => {
    expect(browserHost().readVar(element(), '--color-accent')).toBe('120 80 200');
  });

  test('dpr and now read the page', () => {
    const host = browserHost();
    expect(host.dpr()).toBe(2);
    expect(host.now()).toBeGreaterThan(0);
  });
});

describe('unit · browserMotion', () => {
  test("loop runs ticks on ui's frameLoop until stopped", () => {
    let ticks = 0;
    const stop = browserMotion().loop(() => ticks++, element());
    page.frame();
    page.frame();
    expect(ticks).toBe(2);
    stop();
    page.frame();
    expect(ticks).toBe(2);
  });

  test('allowed reads motionAllowed; onChange subscribes and unsubscribes', () => {
    const motion = browserMotion();
    expect(motion.allowed()).toBe(true);
    const off = motion.onChange(() => {});
    expect(typeof off).toBe('function');
    off();
  });
});
