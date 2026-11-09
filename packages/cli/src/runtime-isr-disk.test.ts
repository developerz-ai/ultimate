// `@ultimat3/render`'s `storageIsrStore` takes an `IsrDisk` — a shape, so render needs no import of
// `@ultimat3/storage`. The CLI depends on both, so this is where the claim "a `StorageDriver` IS an
// `IsrDisk`" is held: by assignment (a build error when the two drift, under the test typecheck)
// and by a round trip over storage's own memory disk, whose not-found refusal the store must read
// as a miss rather than rethrow.

import { describe, expect, test } from 'bun:test';
import type { IsrDisk } from '@ultimat3/render/server';
import { storageIsrStore } from '@ultimat3/render/server';
import type { StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver } from '@ultimat3/storage';

/** Every `StorageDriver`, not only the memory one: the parameter is the claim. */
const asIsrDisk = (driver: StorageDriver): IsrDisk => driver;

describe('a StorageDriver is an IsrDisk', () => {
  test('storageIsrStore over the memory disk: a miss, a write, a shared read, a purge', async () => {
    const disk = asIsrDisk(memoryStorageDriver());
    const one = storageIsrStore({ disk });
    const two = storageIsrStore({ disk });
    expect(await one.get('/blog?page=2')).toBeUndefined();
    await one.set({
      path: '/blog?page=2',
      html: '<p>2</p>',
      hash: 'h',
      generatedAt: 0,
      ttlMs: null,
      stale: false,
    });
    expect((await two.get('/blog?page=2'))?.html).toBe('<p>2</p>');
    expect(await two.paths()).toEqual(['/blog?page=2']);
    const sampled = await one.tagFence?.sample(['post']);
    await two.tagFence?.bump(['post']);
    expect(await one.tagFence?.sample(['post'])).not.toBe(sampled);
    await two.delete('/blog?page=2');
    expect(await one.paths()).toEqual([]);
  });
});
