// Memoization is never required for correctness, so what is actually at stake here is lifetime:
// a value that outlives its request is not a stale read, it is one user's data answering
// another's. These tests hold the store to the context it was born in, and to degrading outside.

import { describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { clearMemo, MEMO_MAX_BYTES, memoBytes, memoSize, memoTier } from './memo';
import { tag } from './tags';

describe('request-memo tier outside a request context', () => {
  test('degrades to a no-op rather than throwing', async () => {
    const tier = memoTier();

    await expect(tier.get('k')).resolves.toBeUndefined();
    await expect(tier.set('k', 'v')).resolves.toBeUndefined();
    await expect(tier.del('k')).resolves.toBeUndefined();
    await expect(tier.invalidateTags([tag('post')])).resolves.toEqual({
      tier: 'request-memo',
      keys: [],
      skipped: 'no request context',
    });
  });
});

describe('request-memo tier inside a request context', () => {
  test('set then get round-trips the value with no expiresAt', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'v');
      const entry = await tier.get('k');
      expect(entry).toEqual({ value: 'v', tags: [] });
      expect(entry).not.toHaveProperty('expiresAt');
    });
  });

  test('set with tags reflects them on get', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'v', { tags: [tag('post', '1')] });
      const entry = await tier.get('k');
      expect(entry).toEqual({ value: 'v', tags: [tag('post', '1')] });
    });
  });

  test('del removes the entry', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'v');
      await tier.del('k');
      await expect(tier.get('k')).resolves.toBeUndefined();
    });
  });

  test('two separate contexts do not share state', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'from-a');
    });

    await runWithContext(ctxOf(), async () => {
      await expect(tier.get('k')).resolves.toBeUndefined();
    });
  });

  test('invalidateTags drops only entries whose tags intersect the request', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('post:list', ['a'], { tags: [tag('post')] });
      await tier.set('post:1', { id: '1' }, { tags: [tag('post', '1')] });
      await tier.set('post:2', { id: '2' }, { tags: [tag('post', '2')] });
      await tier.set('user:list', ['u'], { tags: [tag('user')] });
      await tier.set('untagged', 'keep');

      const result = await tier.invalidateTags([tag('post', '1')]);

      expect(result.tier).toBe('request-memo');
      expect([...result.keys].sort()).toEqual(['post:1', 'post:list']);
      expect(result.skipped).toBeUndefined();

      await expect(tier.get('post:2')).resolves.toBeDefined();
      await expect(tier.get('user:list')).resolves.toBeDefined();
      await expect(tier.get('untagged')).resolves.toBeDefined();
      await expect(tier.get('post:1')).resolves.toBeUndefined();
      await expect(tier.get('post:list')).resolves.toBeUndefined();
    });
  });
});

describe('clearMemo', () => {
  test('drops the current context store mid-request', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'v');
      expect(await tier.get('k')).toBeDefined();
      clearMemo();
      expect(await tier.get('k')).toBeUndefined();
    });
  });

  test('is a safe no-op outside a request context', () => {
    expect(() => clearMemo()).not.toThrow();
  });
});

describe('memoSize', () => {
  test('is 0 with no context', () => {
    expect(memoSize()).toBe(0);
  });

  test('is 0 for an empty store inside a context', async () => {
    await runWithContext(ctxOf(), async () => {
      expect(memoSize()).toBe(0);
    });
  });

  test('reflects entries set inside the current context', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('a', 1);
      await tier.set('b', 2);
      expect(memoSize()).toBe(2);
    });
  });

  test('is unaffected by entries set in a different context', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('a', 1);
      expect(memoSize()).toBe(1);
    });

    await runWithContext(ctxOf(), async () => {
      expect(memoSize()).toBe(0);
    });
  });
});

describe('the per-ctx byte bound', () => {
  // A job's ctx is the whole attempt: a backfill reading one `cache:` query per batch held every
  // page it ever read until the attempt ended — 198 MiB after 2,000 batches of 100 rows, measured.
  const mib = (n: number): string => 'x'.repeat(n * 1024 * 1024);

  test('32 MiB written under one ctx holds at most the bound, oldest evicted first', async () => {
    const tier = memoTier();
    const chunk = 'x'.repeat(512 * 1024);

    await runWithContext(ctxOf(), async () => {
      for (let i = 0; i < 64; i += 1) await tier.set(`k${i}`, chunk);

      expect(memoBytes()).toBeLessThanOrEqual(MEMO_MAX_BYTES);
      expect(memoBytes()).toBeGreaterThan(MEMO_MAX_BYTES - 1024 * 1024);
      await expect(tier.get('k63')).resolves.toBeDefined();
      await expect(tier.get('k0')).resolves.toBeUndefined();
    });
  });

  test('a single entry over the bound is not memoized and evicts nothing', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('small', 'v');
      await tier.set('huge', mib(9));

      await expect(tier.get('huge')).resolves.toBeUndefined();
      await expect(tier.get('small')).resolves.toEqual({ value: 'v', tags: [] });
    });
  });

  test('overwriting, deleting and invalidating a key release its bytes', async () => {
    const tier = memoTier();

    await runWithContext(ctxOf(), async () => {
      await tier.set('k', 'x'.repeat(1000), { tags: [tag('post')] });
      const one = memoBytes();
      await tier.set('k', 'x'.repeat(1000), { tags: [tag('post')] });
      expect(memoBytes()).toBe(one);
      await tier.invalidateTags([tag('post')]);
      expect(memoBytes()).toBe(0);
      await tier.set('k', 'v');
      await tier.del('k');
      expect(memoBytes()).toBe(0);
    });
  });
});
