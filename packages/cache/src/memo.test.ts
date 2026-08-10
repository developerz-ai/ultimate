import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { clearMemo, createMemoTier, memoSize } from './memo';
import { tag } from './tags';

describe('request-memo tier outside a request context', () => {
  test('degrades to a no-op rather than throwing', async () => {
    const tier = createMemoTier();

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
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('k', 'v');
      const entry = await tier.get('k');
      expect(entry).toEqual({ value: 'v', tags: [] });
      expect(entry).not.toHaveProperty('expiresAt');
    });
  });

  test('set with tags reflects them on get', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('k', 'v', { tags: [tag('post', '1')] });
      const entry = await tier.get('k');
      expect(entry).toEqual({ value: 'v', tags: [tag('post', '1')] });
    });
  });

  test('del removes the entry', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('k', 'v');
      await tier.del('k');
      await expect(tier.get('k')).resolves.toBeUndefined();
    });
  });

  test('two separate contexts do not share state', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('k', 'from-a');
    });

    await runWithContext(createContext(), async () => {
      await expect(tier.get('k')).resolves.toBeUndefined();
    });
  });

  test('invalidateTags drops only entries whose tags intersect the request', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
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
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
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
    await runWithContext(createContext(), async () => {
      expect(memoSize()).toBe(0);
    });
  });

  test('reflects entries set inside the current context', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('a', 1);
      await tier.set('b', 2);
      expect(memoSize()).toBe(2);
    });
  });

  test('is unaffected by entries set in a different context', async () => {
    const tier = createMemoTier();

    await runWithContext(createContext(), async () => {
      await tier.set('a', 1);
      expect(memoSize()).toBe(1);
    });

    await runWithContext(createContext(), async () => {
      expect(memoSize()).toBe(0);
    });
  });
});
