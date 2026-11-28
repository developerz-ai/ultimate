// Scroll-linked progress rides the browser's own scroll timelines — the engine behind CSS
// `animation-timeline` — never a scroll listener. Unsupported or stilled, the element rests.

import { afterEach, describe, expect, test } from 'bun:test';
import { installGlobals } from '../browser-fake-fixture';
import { scrollLinked } from './scroll-linked';

let restore = (): void => {};
afterEach(() => restore());

class FakeViewTimeline {
  constructor(readonly init: Record<string, unknown>) {}
}

function page(options: { reduced?: boolean; timelines?: boolean } = {}): void {
  restore = installGlobals({
    window: {},
    document: { documentElement: { getAttribute: () => null }, scrollingElement: {} },
    matchMedia: () => ({ matches: options.reduced === true }),
    ViewTimeline: options.timelines === false ? undefined : FakeViewTimeline,
    ScrollTimeline: options.timelines === false ? undefined : FakeViewTimeline,
  });
}

function fakeElement() {
  const calls: { keyframes: Keyframe[]; options: Record<string, unknown> }[] = [];
  let cancelled = 0;
  const el = {
    animate(keyframes: Keyframe[], options: Record<string, unknown>) {
      calls.push({ keyframes, options });
      return { cancel: () => (cancelled += 1) };
    },
  };
  return { el: el as unknown as Element, calls, cancelled: () => cancelled };
}

describe('scrollLinked', () => {
  test('a view timeline on the element itself, over the range asked for', () => {
    page();
    const { el, calls, cancelled } = fakeElement();
    const stop = scrollLinked(el, [{ opacity: 0 }, { opacity: 1 }], {
      range: ['entry 0%', 'cover 40%'],
    });
    const call = calls[0];
    expect(call?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect((call?.options['timeline'] as FakeViewTimeline | undefined)?.init).toEqual({
      subject: el,
      axis: 'block',
    });
    expect(call?.options['rangeStart']).toBe('entry 0%');
    expect(call?.options['rangeEnd']).toBe('cover 40%');
    stop();
    expect(cancelled()).toBe(1);
  });

  test('source: scroll follows the page scroller instead', () => {
    page();
    const { el, calls } = fakeElement();
    scrollLinked(el, [{ scale: 1 }, { scale: 2 }], { source: 'scroll', axis: 'inline' });
    expect((calls[0]?.options['timeline'] as FakeViewTimeline | undefined)?.init).toEqual({
      source: {},
      axis: 'inline',
    });
  });

  test('no scroll timelines, or reduced motion: nothing runs and the element rests', () => {
    for (const options of [{ timelines: false }, { reduced: true }]) {
      page(options);
      const { el, calls } = fakeElement();
      scrollLinked(el, [{ opacity: 0 }, { opacity: 1 }])();
      expect(calls).toEqual([]);
      restore();
    }
  });
});
