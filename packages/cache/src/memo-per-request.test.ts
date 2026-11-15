// `memoPerRequest` is the request memo for a plain function: once per ctx and key, straight
// through outside a ctx, and bounded by the same per-ctx byte budget as the tier it shares.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { MEMO_MAX_BYTES, memoBytes, memoTier } from './memo';
import { memoPerRequest } from './memo-per-request';

function counted<A extends readonly unknown[], R>(fn: (...args: A) => R) {
  const calls: A[] = [];
  return {
    calls,
    fn: (...args: A): R => {
      calls.push(args);
      return fn(...args);
    },
  };
}

describe('memoPerRequest', () => {
  test('calls fn once per ctx and key', async () => {
    const spy = counted((id: string) => ({ id }));
    const load = memoPerRequest(spy.fn, (id) => id);

    await runWithContext(ctxOf(), async () => {
      expect(load('a')).toEqual({ id: 'a' });
      expect(load('a')).toEqual({ id: 'a' });
      expect(load('b')).toEqual({ id: 'b' });
    });
    expect(spy.calls).toEqual([['a'], ['b']]);

    await runWithContext(ctxOf(), async () => {
      load('a');
    });
    expect(spy.calls).toHaveLength(3);
  });

  test('outside a ctx it calls straight through, every time', () => {
    const spy = counted(() => 1);
    const load = memoPerRequest(spy.fn, () => 'k');

    load();
    load();
    expect(spy.calls).toHaveLength(2);
  });

  test('two wrappers with the same key do not answer for each other', async () => {
    const a = memoPerRequest(
      () => 'a',
      () => 'k',
    );
    const b = memoPerRequest(
      () => 'b',
      () => 'k',
    );

    await runWithContext(ctxOf(), async () => {
      expect(a()).toBe('a');
      expect(b()).toBe('b');
    });
  });

  test('a key is not a memoTier key: the tier neither reads nor clobbers it', async () => {
    const tier = memoTier();
    const load = memoPerRequest(
      () => 'fn',
      () => 'k',
    );

    await runWithContext(ctxOf(), async () => {
      expect(load()).toBe('fn');
      await expect(tier.get('k')).resolves.toBeUndefined();
      await tier.set('k', 'tier');
      expect(load()).toBe('fn');
    });
  });

  test('concurrent async calls join one flight; a rejection is not memoized', async () => {
    let n = 0;
    const load = memoPerRequest(
      async () => {
        n += 1;
        if (n === 1) expect.unreachable('the first attempt fails');
        return n;
      },
      () => 'k',
    );

    await runWithContext(ctxOf(), async () => {
      const [first, second] = await Promise.allSettled([load(), load()]);
      expect(first.status).toBe('rejected');
      expect(second.status).toBe('rejected');
      expect(n).toBe(1);
      expect(await load()).toBe(2);
      expect(await load()).toBe(2);
      expect(n).toBe(2);
    });
  });

  test('a settled async value is charged against the same per-ctx bound', async () => {
    const load = memoPerRequest(async (i: number) => `${i}`.padEnd(512 * 1024, 'x'), String);

    await runWithContext(ctxOf(), async () => {
      for (let i = 0; i < 64; i += 1) await load(i);
      expect(memoBytes()).toBeLessThanOrEqual(MEMO_MAX_BYTES);
      expect(memoBytes()).toBeGreaterThan(MEMO_MAX_BYTES - 1024 * 1024);
    });
  });
});

describe('memoPerRequest(...).forget', () => {
  test('drops that key in this ctx: the next call runs fn again, other keys stay held', async () => {
    const spy = counted((id: string) => ({ id }));
    const load = memoPerRequest(spy.fn, (id) => id);

    await runWithContext(ctxOf(), async () => {
      load('a');
      load('b');
      load.forget('a');
      load('a');
      load('b');
    });
    expect(spy.calls).toEqual([['a'], ['b'], ['a']]);
  });

  test('gives the forgotten entry its bytes back', async () => {
    const load = memoPerRequest(
      (id: string) => 'x'.repeat(10_000) + id,
      (id) => id,
    );

    await runWithContext(ctxOf(), async () => {
      load('a');
      const held = memoBytes();
      load('b');
      expect(memoBytes()).toBeGreaterThan(held);
      load.forget('b');
      expect(memoBytes()).toBe(held);
      load.forget('a');
      expect(memoBytes()).toBe(0);
    });
  });

  test('forgets only its own key space, and is a no-op outside a ctx', async () => {
    const a = counted(() => 'a');
    const b = counted(() => 'b');
    const loadA = memoPerRequest(a.fn, () => 'k');
    const loadB = memoPerRequest(b.fn, () => 'k');

    loadA.forget();
    await runWithContext(ctxOf(), async () => {
      loadA();
      loadB();
      loadA.forget();
      loadA();
      loadB();
    });
    expect(a.calls).toHaveLength(2);
    expect(b.calls).toHaveLength(1);
  });
});
