// The CDN is the one tier Ultimate never reads back from, so the emitted header and the purge
// call ARE the contract — a wrong `Surrogate-Key` is a stale page that no later read can catch,
// and an unimplemented driver that fails quietly is the same outage with no stack trace.

import { describe, expect, test } from 'bun:test';
import type { PurgeDriver } from './cdn';
import { cacheHeaders, cdnTier, noopPurgeDriver, surrogateKeys } from './cdn';
import { CachePurgeFailedError } from './errors';
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

  test('tags become a space-joined Surrogate-Key, with the entity index beside them', () => {
    // `e:post` is what a collection bust purges. Without it a detail page keyed `post:1` alone is
    // unreachable by `invalidateTags([tag.post])` and serves for its whole `s-maxage`.
    const headers = cacheHeaders({ tags: [tag('post'), tag('post', '1')] });
    expect(headers['Surrogate-Key']).toBe('post e:post post:1');
  });

  test('a row tag alone still carries its entity index, once per entity', () => {
    const headers = cacheHeaders({ tags: [tag('post', '1'), tag('post', '2'), tag('user', '9')] });
    expect(headers['Surrogate-Key']).toBe('post:1 e:post post:2 user:9 e:user');
  });

  test('a tag a CDN would split is refused at EMISSION, not on the purge nobody watches', () => {
    // `post:a b` goes out as two keys, `post:a` and `b`; the purge of `post:a b` is refused by
    // the driver's own guard. Tagged and unpurgeable — so the response is never tagged that way.
    for (const id of ['a b', 'a,b', 'a\tb']) {
      try {
        cacheHeaders({ tags: [tag('post', id)] });
        expect.unreachable('an unpurgeable key was emitted');
      } catch (error) {
        expect(error).toBeInstanceOf(CachePurgeFailedError);
        expect((error as CachePurgeFailedError).code).toBe('X_CACHE_PURGE_FAILED');
        expect((error as CachePurgeFailedError).cause).toContain('cacheHeaders');
      }
    }
    expect(() => surrogateKeys([tag('po st')])).toThrow(CachePurgeFailedError);
  });

  test('a private response screens nothing, because it carries no key', () => {
    expect(cacheHeaders({ visibility: 'private', tags: [tag('post', 'a b')] })).toEqual({
      'Cache-Control': 'private, no-store',
    });
  });

  // Cloudflare reads `Cache-Tag`, comma-separated, and never `Surrogate-Key`; the two headers are
  // what `@ultimat3/http`'s `applyCacheHeaders` emits too, so a purge reaches either CDN.
  test('the same tags become a comma-joined Cache-Tag', () => {
    expect(cacheHeaders({ tags: [tag('post'), tag('post', '1')] })['Cache-Tag']).toBe(
      'post,e:post,post:1',
    );
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
    // `PurgeDriver.purge` promises the accepted keys, not the caller's array object: a driver
    // that maps or copies before resolving is conforming, so identity is not the contract.
    await expect(driver.purge(keys)).resolves.toEqual(keys);
  });

  test('purgeAll resolves without throwing', async () => {
    await expect(noopPurgeDriver().purgeAll()).resolves.toBeUndefined();
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

describe('cdnTier', () => {
  test('is named "cdn"', () => {
    expect(cdnTier().name).toBe('cdn');
  });

  test('get always resolves undefined regardless of key', async () => {
    const tier = cdnTier();
    expect(await tier.get('anything')).toBeUndefined();
    expect(await tier.get('')).toBeUndefined();
  });

  test('set is a no-op that resolves', async () => {
    const tier = cdnTier();
    await expect(tier.set('k', { a: 1 })).resolves.toBeUndefined();
  });

  test('del only purges when pathsForKey returns a non-empty array', async () => {
    const { driver, calls } = purgeSpy();
    const tier = cdnTier({
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
    const tier = cdnTier({ purge: driver });

    const result = await tier.invalidateTags([]);

    expect(result).toEqual({ tier: 'cdn', keys: [] });
    expect(calls).toHaveLength(0);
  });

  test('a tier with no purge driver reports SKIPPED, never a list of cleared keys', async () => {
    // The default state of every deployment with no CDN credentials — `selectPurgeDriver` answers
    // `noopPurgeDriver()` for exactly that env. The noop echoes its argument back, so the tier
    // reported every tag as CLEARED and `recentInvalidations().busted` picked it up with no
    // errors: a partial bust reading as a clean one, which is the log's whole job to prevent.
    const tier = cdnTier();

    const result = await tier.invalidateTags([tag('post'), tag('post', '1')]);

    expect(result).toEqual({
      tier: 'cdn',
      keys: [],
      skipped: 'no purge driver configured',
    });
  });

  test('invalidateTags surfaces the driver-accepted keys', async () => {
    const { driver, calls } = purgeSpy((keys) => keys.filter((key) => key === 'post'));
    const tier = cdnTier({ purge: driver });

    const result = await tier.invalidateTags([tag('post'), tag('post', '1')]);

    expect(calls).toEqual([['e:post', 'post', 'post:1']]);
    expect(result).toEqual({ tier: 'cdn', keys: ['post'] });
  });

  test('a ROW bust purges the row and the bare collection key, never the entity index', async () => {
    // The list keyed `post` contained the row, so it goes. `e:post` is on every response of the
    // entity: purging it here would clear `post:2`'s page for a write to `post:1`.
    const { driver, calls } = purgeSpy();
    await cdnTier({ purge: driver }).invalidateTags([tag('post', '1')]);
    expect(calls).toEqual([['post:1', 'post']]);
  });

  test('a COLLECTION bust purges the entity index, and the bare key older responses carry', async () => {
    const { driver, calls } = purgeSpy();
    await cdnTier({ purge: driver }).invalidateTags([tag('post')]);
    expect(calls).toEqual([['e:post', 'post']]);
  });

  test('a bust of an unpurgeable tag is refused before any driver is asked', async () => {
    const { driver, calls } = purgeSpy();
    await expect(cdnTier({ purge: driver }).invalidateTags([tag('post', 'a b')])).rejects.toThrow(
      CachePurgeFailedError,
    );
    expect(calls).toEqual([]);
  });
});
