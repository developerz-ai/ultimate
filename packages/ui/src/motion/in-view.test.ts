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
