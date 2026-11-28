// `animate` is WAAPI with the token scale in front of it: typed transform parts compose into one
// `transform`, timing comes from `motionTiming`, and a stilled page still FINISHES (no hang).

import { afterEach, describe, expect, test } from 'bun:test';
import { installGlobals } from '../browser-fake-fixture';
import { animate, toKeyframe } from './animate';
import { STILL_MS } from './motion-timing';
import { stagger } from './stagger';

interface Call {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
}

function fakeElement() {
  const calls: Call[] = [];
  const log: string[] = [];
  let finish = (): void => {};
  const el = {
    animate(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ keyframes, options });
      return {
        finished: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        cancel: () => log.push('cancel'),
        reverse: () => log.push('reverse'),
      };
    },
  };
  return { el: el as unknown as Element, calls, log, finish: () => finish() };
}

let restore = (): void => {};
afterEach(() => restore());

/** A page where motion is allowed and the stylesheet resolved `--duration-base` to 200ms. */
function page(reduced = false): void {
  restore = installGlobals({
    window: {},
    document: { documentElement: { getAttribute: () => null } },
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: () => ({
      getPropertyValue: (name: string) =>
        ({ '--duration-base': '200ms', '--duration-fast': '100ms', '--easing-out': 'ease-out' })[
          name
        ] ?? '',
    }),
  });
}

describe('toKeyframe', () => {
  test('x, y, scale and rotate compose into one transform, in a fixed order', () => {
    expect(toKeyframe({ rotate: 90, x: 8, y: '0.5rem', scale: 0.9, opacity: 0 })).toEqual({
      transform: 'translate(8px, 0.5rem) scale(0.9) rotate(90deg)',
      opacity: 0,
    });
  });

  test('a frame with no transform part carries no transform', () => {
    expect(toKeyframe({ opacity: 1 })).toEqual({ opacity: 1 });
  });
});

describe('animate', () => {
  test('runs on the resolved duration and easing tokens, holding nothing after it ends', () => {
    page();
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }]);
    expect(calls[0]?.options).toEqual({
      duration: 200,
      easing: 'ease-out',
      delay: 0,
      fill: 'backwards',
    });
  });

  test('finished resolves when the animation does; cancel and reverse reach it', async () => {
    page();
    const { el, log, finish } = fakeElement();
    const handle = animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 'fast' });
    handle.reverse();
    handle.cancel();
    finish();
    await handle.finished;
    expect(log).toEqual(['reverse', 'cancel']);
  });

  test('under reduced motion it is stilled and its delay dropped — it still finishes', () => {
    page(true);
    const { el, calls } = fakeElement();
    animate(el, [{ opacity: 0 }, { opacity: 1 }], { delay: 300 });
    expect(calls[0]?.options.duration).toBe(STILL_MS);
    expect(calls[0]?.options.delay).toBe(0);
  });

  test('an element with no animate() (a server, an old engine) is already finished', async () => {
    const handle = animate({} as Element, [{ opacity: 1 }]);
    await handle.finished;
    handle.cancel();
  });
});

describe('stagger', () => {
  test('each element starts one `each` after the last, capped at `limit` steps', () => {
    page();
    const made = [1, 2, 3, 4].map(() => fakeElement());
    stagger(
      made.map((m) => m.el),
      [{ opacity: 0 }, { opacity: 1 }],
      { each: 'fast', limit: 2 },
    );
    expect(made.map((m) => m.calls[0]?.options.delay)).toEqual([0, 100, 200, 200]);
  });

  test('one handle finishes when every element has, and cancels them all', async () => {
    page();
    const made = [1, 2].map(() => fakeElement());
    const handle = stagger(
      made.map((m) => m.el),
      [{ opacity: 0 }, { opacity: 1 }],
    );
    handle.cancel();
    for (const m of made) m.finish();
    await handle.finished;
    expect(made.map((m) => m.log)).toEqual([['cancel'], ['cancel']]);
  });
});

describe('animate — delay is screened', () => {
  test('a NaN or infinite delay is refused, never handed to WAAPI', () => {
    page();
    const { el, calls } = fakeElement();
    for (const delay of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => animate(el, [{ opacity: 0 }, { opacity: 1 }], { delay })).toThrow();
    }
    expect(calls).toEqual([]);
  });
});
