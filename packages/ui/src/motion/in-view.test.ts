// One IntersectionObserver per (margin, amount) for the whole page, however many elements watch:
// a list of a hundred cards is one observer with a hundred targets, never a hundred observers.

import { afterEach, describe, expect, test } from 'bun:test';
import { installGlobals } from '../browser-fake-fixture';
import { inView } from './in-view';

type Report = (
  entries: { target: Element; isIntersecting: boolean; intersectionRatio: number }[],
) => void;

class FakeObserver {
  static made: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(
    readonly report: Report,
    readonly init: { rootMargin?: string; threshold?: number },
  ) {
    FakeObserver.made.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  show(el: Element, visible: boolean): void {
    this.report([{ target: el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
  }
}

let restore = (): void => {};
afterEach(() => {
  restore();
  FakeObserver.made = [];
});
const install = (): void => {
  restore = installGlobals({ IntersectionObserver: FakeObserver });
};
const el = (): Element => ({}) as Element;

describe('inView', () => {
  test('many elements with the same options share one observer', () => {
    install();
    const stops = [el(), el(), el()].map((target) => inView(target, () => {}));
    expect(FakeObserver.made.length).toBe(1);
    expect(FakeObserver.made[0]?.targets.size).toBe(3);
    inView(el(), () => {}, { margin: '0px 0px -20% 0px' });
    expect(FakeObserver.made.length).toBe(2);
    for (const stop of stops) stop();
  });

  test('once (the default): enters a single time and stops watching', () => {
    install();
    const target = el();
    let entered = 0;
    inView(target, () => {
      entered += 1;
    });
    const observer = FakeObserver.made.at(-1) as FakeObserver;
    observer.show(target, true);
    observer.show(target, false);
    observer.show(target, true);
    expect(entered).toBe(1);
    expect(observer.targets.has(target)).toBe(false);
  });

  test('once: false — enter and the returned leave alternate', () => {
    install();
    const target = el();
    const log: string[] = [];
    const stop = inView(
      target,
      () => {
        log.push('in');
        return () => log.push('out');
      },
      { once: false },
    );
    const observer = FakeObserver.made.at(-1) as FakeObserver;
    observer.show(target, false);
    observer.show(target, true);
    observer.show(target, false);
    observer.show(target, true);
    stop();
    observer.show(target, false);
    expect(log).toEqual(['in', 'out', 'in']);
    expect(observer.targets.size).toBe(0);
  });

  test('no IntersectionObserver: the content is shown at once, never left hidden', () => {
    restore = installGlobals({ IntersectionObserver: undefined });
    let entered = false;
    inView(el(), () => {
      entered = true;
    });
    expect(entered).toBe(true);
  });
});

describe('inView — many watches on one element', () => {
  test('two watches on one element both fire, and one stop leaves the other watching', () => {
    install();
    const target = el();
    const log: string[] = [];
    const stopA = inView(target, () => void log.push('a'), { once: false });
    const stopB = inView(target, () => void log.push('b'), { once: false });
    const observer = FakeObserver.made.at(-1) as FakeObserver;
    observer.show(target, true);
    expect(log).toEqual(['a', 'b']);
    stopA();
    expect(observer.targets.has(target)).toBe(true);
    observer.show(target, false);
    observer.show(target, true);
    expect(log).toEqual(['a', 'b', 'b']);
    stopB();
  });

  test('a once watch that re-arms inView on its element keeps the new watch', () => {
    install();
    const target = el();
    const log: string[] = [];
    let stopSecond = (): void => {};
    inView(target, () => {
      log.push('first');
      stopSecond = inView(target, () => void log.push('second'), { once: false });
      return undefined;
    });
    const observer = FakeObserver.made.at(-1) as FakeObserver;
    observer.show(target, true);
    expect(observer.targets.has(target)).toBe(true);
    observer.show(target, false);
    observer.show(target, true);
    expect(log).toEqual(['first', 'second']);
    stopSecond();
  });

  test('a pool emptied inside a callback never deletes the pool created after it', () => {
    install();
    const a = el();
    const b = el();
    let stopB = (): void => {};
    const stop = inView(a, () => {
      // The pool's last watch stops itself; the next inView with the same options is a NEW pool.
      stop();
      stopB = inView(b, () => undefined, { once: false });
      return undefined;
    });
    const first = FakeObserver.made.at(-1) as FakeObserver;
    first.show(a, true);
    const second = FakeObserver.made.at(-1) as FakeObserver;
    expect(second).not.toBe(first);
    expect(second.targets.has(b)).toBe(true);
    // The new pool is still the one handed out: a third watch joins it, no third observer.
    const stopC = inView(el(), () => undefined, { once: false });
    expect(FakeObserver.made.length).toBe(2);
    stopB();
    stopC();
  });
});
