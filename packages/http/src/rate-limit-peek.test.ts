// `peek` on the memory store: the bucket as a take would see it, refill applied, and nothing
// changed — no entry for a key never taken, no refill written back to one that was.

import { describe, expect, test } from 'bun:test';
import type { Bucket } from './rate-limit';
import { memoryRateLimitStore } from './rate-limit';
import { rateLimitPeek } from './rate-limit-peek';

const bucket: Bucket = { capacity: 4, refillPerSecond: 1 };

describe('memoryRateLimitStore.peek', () => {
  test('a key never taken is full, and peeking it creates no entry', async () => {
    const store = memoryRateLimitStore();
    expect(await store.peek('fresh', bucket, 1_000)).toEqual({
      remaining: 4,
      retryAfterSeconds: 0,
    });
    expect(store.size).toBe(0);
  });

  test('agrees with the next take and writes no refill back', async () => {
    const store = memoryRateLimitStore();
    await store.take('k', bucket, 4, 1_000);
    expect(await store.peek('k', bucket, 1_000)).toEqual({ remaining: 0, retryAfterSeconds: 1 });
    expect(await store.peek('k', bucket, 3_500)).toEqual({ remaining: 2, retryAfterSeconds: 0 });
    // Had the peek written its refill at 3 500, a take at 3 500 would see the same 2.5 — so
    // assert against an instant BEFORE it: the stored state is still the 1 000 one.
    expect((await store.take('k', bucket, 1, 1_500)).allowed).toBe(false);
  });
});

describe('rateLimitPeek', () => {
  test('a bucket that never refills says a day, as a decision does', () => {
    expect(rateLimitPeek({ capacity: 1, refillPerSecond: 0 }, 0)).toEqual({
      remaining: 0,
      retryAfterSeconds: 86_400,
    });
  });
});
