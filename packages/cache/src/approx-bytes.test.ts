// The memo's byte charge is a SAMPLE, so two things are pinned: the work is bounded whatever the
// value's size (counted in property reads), and the figure stays within 2x of the exact
// `estimateBytes` on the shapes a query returns — or the 8 MiB bound stops meaning 8 MiB.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { approxBytes } from './approx-bytes';
import { estimateBytes } from './lru';

/** The hostile read: coded, so the throw is this test's INPUT and never a bare verdict. */
const refusal = (what: string): UltimateError =>
  new UltimateError({
    code: 'X_INTERNAL',
    cause: `${what} refuses, standing in for a hostile value a query returned`,
    fix: 'bun test ./packages/cache/src/approx-bytes.test.ts',
  });

const row = (i: number) => ({
  id: `c0a8-${i}`,
  orgId: 'org_1',
  title: `A post title number ${i}`,
  slug: `post-${i}`,
  body: 'Lorem ipsum dolor sit amet '.repeat(3),
  status: 'published',
  views: i * 7,
  score: 0.5 + i,
  createdAt: new Date(1_700_000_000_000 + i),
  tags: ['a', 'b'],
});

function within2x(value: unknown): void {
  const exact = estimateBytes(value);
  const approx = approxBytes(value);
  expect(approx).toBeGreaterThanOrEqual(exact / 2);
  expect(approx).toBeLessThanOrEqual(exact * 2);
}

describe('approxBytes', () => {
  test('within 2x of estimateBytes for 1, 50 and 500-row pages and a big string', () => {
    for (const n of [1, 50, 500]) within2x(Array.from({ length: n }, (_, i) => row(i)));
    within2x({ rows: Array.from({ length: 50 }, (_, i) => row(i)), total: 50 });
    within2x('x'.repeat(100_000));
    within2x(new Map(Array.from({ length: 100 }, (_, i) => [`k${i}`, row(i)])));
  });

  test('reads a bounded number of properties however long the array', () => {
    let reads = 0;
    const counted = (i: number) => {
      const out = {};
      Object.defineProperty(out, 'title', {
        enumerable: true,
        get: () => {
          reads += 1;
          return `title ${i}`;
        },
      });
      return out;
    };
    approxBytes(Array.from({ length: 100_000 }, (_, i) => counted(i)));
    expect(reads).toBeLessThanOrEqual(8);
  });

  test('a cycle or a deep nest terminates', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(approxBytes(cyclic)).toBeGreaterThan(0);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 10_000; i += 1) deep = [deep];
    expect(approxBytes(deep)).toBeGreaterThan(0);
  });
});

describe('approxBytes on a value that throws when read', () => {
  // The charge runs inside a promise's `.then`: a throw here was an unhandled rejection, and the
  // process exited 1 over a cache estimate.
  const throwingGetter = (): object =>
    Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        throw refusal('the getter');
      },
    });
  const throwingProxy = (): object =>
    new Proxy(
      {},
      {
        ownKeys() {
          throw refusal('ownKeys');
        },
      },
    );

  test('an enumerable getter that throws is charged, not thrown', () => {
    expect(approxBytes(throwingGetter())).toBeGreaterThan(0);
    expect(approxBytes([throwingGetter()])).toBeGreaterThan(0);
  });

  test('a Proxy whose ownKeys throws is charged, not thrown', () => {
    expect(approxBytes(throwingProxy())).toBeGreaterThan(0);
    expect(approxBytes({ rows: [throwingProxy()] })).toBeGreaterThan(0);
  });
});
