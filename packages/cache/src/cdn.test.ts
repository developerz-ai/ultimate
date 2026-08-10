import { describe, expect, test } from 'bun:test';
import type { PurgeDriver } from './cdn';
import {
  cacheHeaders,
  cloudflarePurgeDriver,
  createCdnTier,
  fastlyPurgeDriver,
  noopPurgeDriver,
} from './cdn';
import { CacheNotImplementedError } from './errors';
import { tag } from './tags';

describe('cacheHeaders', () => {
  test('defaults to public, max-age=0, no Surrogate-Key', () => {
    expect(cacheHeaders()).toEqual({ 'Cache-Control': 'public, max-age=0' });
  });

  test('visibility: private ignores every other option', () => {
    const headers = cacheHeaders({
      visibility: 'private',
      maxAge: 60,
      sMaxAge: 120,
      staleWhileRevalidate: 30,
      staleIfError: 10,
      immutable: true,
      tags: [tag('post')],
    });
    expect(headers).toEqual({ 'Cache-Control': 'private, no-store' });
  });

  test('assembles every directive in source order', () => {
    const headers = cacheHeaders({
      maxAge: 60,
      sMaxAge: 120,
      staleWhileRevalidate: 30,
      staleIfError: 10,
      immutable: true,
    });
    expect(headers['Cache-Control']).toBe(
      'public, max-age=60, s-maxage=120, stale-while-revalidate=30, stale-if-error=10, immutable',
    );
  });

  test('tags become a space-joined Surrogate-Key', () => {
    const headers = cacheHeaders({ tags: [tag('post'), tag('post', '1')] });
    expect(headers['Surrogate-Key']).toBe('post post:1');
  });

  test('an empty tags array omits Surrogate-Key entirely', () => {
    const headers = cacheHeaders({ tags: [] });
    expect(headers['Surrogate-Key']).toBeUndefined();
    expect(Object.keys(headers)).toEqual(['Cache-Control']);
  });
});

describe('noopPurgeDriver', () => {
  test('is named "noop"', () => {
    expect(noopPurgeDriver().name).toBe('noop');
  });

  test('purge echoes back the same keys it was given', async () => {
    const driver = noopPurgeDriver();
    const keys = ['post', 'post:1'];
    await expect(driver.purge(keys)).resolves.toBe(keys);
  });

  test('purgeAll resolves without throwing', async () => {
    await expect(noopPurgeDriver().purgeAll()).resolves.toBeUndefined();
  });
});

describe('remote purge drivers', () => {
  test('fastlyPurgeDriver is named "fastly" and throws synchronously, unimplemented', () => {
    const driver = fastlyPurgeDriver();
    expect(driver.name).toBe('fastly');
    expect(() => driver.purge(['post'])).toThrow(CacheNotImplementedError);
    expect(() => driver.purgeAll()).toThrow(CacheNotImplementedError);
  });

  test('cloudflarePurgeDriver is named "cloudflare" and throws synchronously, unimplemented', () => {
    const driver = cloudflarePurgeDriver();
    expect(driver.name).toBe('cloudflare');
    expect(() => driver.purge(['post'])).toThrow(CacheNotImplementedError);
    expect(() => driver.purgeAll()).toThrow(CacheNotImplementedError);
  });
});

const purgeSpy = (accept?: (keys: readonly string[]) => readonly string[]) => {
  const calls: (readonly string[])[] = [];
  const driver: PurgeDriver = {
    name: 'spy',
    purge(keys) {
      calls.push(keys);
      return Promise.resolve(accept ? accept(keys) : keys);
    },
    purgeAll() {
      return Promise.resolve();
    },
  };
  return { driver, calls };
};

describe('createCdnTier', () => {
  test('is named "cdn"', () => {
    expect(createCdnTier().name).toBe('cdn');
  });

  test('get always resolves undefined regardless of key', async () => {
    const tier = createCdnTier();
    expect(await tier.get('anything')).toBeUndefined();
    expect(await tier.get('')).toBeUndefined();
  });

  test('set is a no-op that resolves', async () => {
    const tier = createCdnTier();
    await expect(tier.set('k', { a: 1 })).resolves.toBeUndefined();
  });

  test('del only purges when pathsForKey returns a non-empty array', async () => {
    const { driver, calls } = purgeSpy();
    const tier = createCdnTier({
      purge: driver,
      pathsForKey: (key) => (key === 'post-1' ? ['/a', '/b'] : []),
    });

    await tier.del('untouched');
    expect(calls).toHaveLength(0);

    await tier.del('post-1');
    expect(calls).toEqual([['/a', '/b']]);
  });

  test('invalidateTags([]) short-circuits without calling the driver', async () => {
    const { driver, calls } = purgeSpy();
    const tier = createCdnTier({ purge: driver });

    const result = await tier.invalidateTags([]);

    expect(result).toEqual({ tier: 'cdn', keys: [] });
    expect(calls).toHaveLength(0);
  });

  test('invalidateTags purges the serialized wire tags and surfaces the driver-accepted keys', async () => {
    const { driver, calls } = purgeSpy((keys) => keys.filter((key) => key === 'post'));
    const tier = createCdnTier({ purge: driver });

    const result = await tier.invalidateTags([tag('post'), tag('post', '1')]);

    expect(calls).toEqual([['post', 'post:1']]);
    expect(result).toEqual({ tier: 'cdn', keys: ['post'] });
  });
});
