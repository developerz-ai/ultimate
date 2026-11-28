// A feed row reveals once it is in view, and the rows that arrive together start one beat apart —
// proven on fake elements: the WAAPI `animate` each one records is the whole observable.

import { afterEach, beforeEach, describe, expect, test } from '@ultimat3/testing';
import { revealRow } from './feed-reveal';

/** A page where motion is allowed and the token sheet resolved `--duration-fast` to 100 ms. */
const PAGE: Record<string, unknown> = {
  window: {},
  document: { documentElement: { getAttribute: () => null } },
  matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({
    getPropertyValue: (name: string) =>
      ({ '--duration-fast': '100ms', '--duration-base': '200ms', '--easing-gentle': 'ease' })[
        name
      ] ?? '',
  }),
};

const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  for (const [name, value] of Object.entries(PAGE)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
});

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
});

const row = (starts: number[]): Element =>
  ({
    animate(_frames: Keyframe[], options: KeyframeAnimationOptions) {
      starts.push(Number(options.delay));
      return { finished: Promise.resolve(), cancel() {}, reverse() {} };
    },
  }) as unknown as Element;

describe('revealRow', () => {
  test('rows that enter in one tick start one beat apart, in order', async () => {
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) revealRow(row(starts));
    await Promise.resolve();
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeGreaterThan(0);
    expect(starts[2]).toBe((starts[1] as number) * 2);
  });

  test('a later row starts a fresh batch at no delay', async () => {
    const starts: number[] = [];
    revealRow(row(starts));
    await Promise.resolve();
    revealRow(row(starts));
    await Promise.resolve();
    expect(starts).toEqual([0, 0]);
  });
});
