// The request memo under a job's ctx. A job's ctx is the whole attempt, so a backfill reading one
// query per batch held every page it read until the attempt ended. The memo is
// `@ultimat3/cache`'s store and answers to its per-ctx byte bound — one store, one bound.

import { describe, expect, spyOn, test } from 'bun:test';
import { MEMO_MAX_BYTES } from '@ultimat3/cache';
import { ctxOf } from '@ultimat3/core';
import { readOnce, requestMemo } from './cache';

describe('the request memo is bounded per ctx', () => {
  test('a backfill-shaped loop under one ctx stays within MEMO_MAX_BYTES, oldest gone', async () => {
    const ctx = ctxOf({});
    const page = 'x'.repeat(512 * 1024);
    let calls = 0;

    for (let batch = 0; batch < 64; batch += 1) {
      await readOnce(ctx, `posts.page:${batch}`, async () => {
        calls += 1;
        return page;
      });
    }

    const memo = requestMemo(ctx);
    expect(memo.bytes).toBeLessThanOrEqual(MEMO_MAX_BYTES);
    expect(memo.bytes).toBeGreaterThan(MEMO_MAX_BYTES - 1024 * 1024);
    expect(memo.has('posts.page:63')).toBe(true);
    expect(memo.has('posts.page:0')).toBe(false);
    expect(calls).toBe(64);
  });

  test('an evicted read is read again, never answered wrong', async () => {
    const ctx = ctxOf({});
    const page = (n: number): string => `${n}`.padEnd(512 * 1024, 'x');

    for (let batch = 0; batch < 64; batch += 1) {
      await readOnce(ctx, `p:${batch}`, async () => page(batch));
    }
    expect(await readOnce(ctx, 'p:0', async () => page(0))).toBe(page(0));
  });
});

describe('what the bound costs a read', () => {
  // Measuring a read by stringifying its rows cost 160 µs on a 50-row page and 1.5 ms on 500 —
  // against a 1 µs memo. The bound is charged from a bounded sample, never a full serialisation.
  test('a 500-row read is charged without one JSON.stringify', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ id: `r${i}`, title: 'x'.repeat(40) }));
    const stringify = spyOn(JSON, 'stringify');
    try {
      await readOnce(ctxOf({}), 'page', async () => rows);
      await Promise.resolve();
      expect(stringify).toHaveBeenCalledTimes(0);
    } finally {
      stringify.mockRestore();
    }
  });
});
