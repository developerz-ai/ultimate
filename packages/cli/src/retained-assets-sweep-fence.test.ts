// The sweep's fenced deletes, case by case: a file a manifest names by the fence is put back with
// its bytes and type, an unreadable fence puts the chunk back whole, a file that cannot be held is
// spared, and a dropped manifest is deleted only while it holds the date it was dropped at.

import { describe, expect, test } from 'bun:test';
import type { StorageDriver } from '@ultimat3/storage';
import { memoryStorageDriver, StorageError } from '@ultimat3/storage';
import { manifestKey, retainedFileKey, retainedPrefix } from './retained-assets-layout';
import { deleteFenced, deleteManifestIfUnchanged } from './retained-assets-sweep-fence';

const PREFIX = retainedPrefix('app', 'production');
const URL_A = '/islands/a-11111111.js';
const KEY_A = retainedFileKey(PREFIX, URL_A);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const manifest = (buildId: string, publishedAt: number, urls: readonly string[]): Uint8Array =>
  bytes(JSON.stringify({ buildId, publishedAt, urls }));
const refusing = (memory: StorageDriver, key: string, code: string): StorageDriver => ({
  ...memory,
  get: async (asked, options) => {
    if (asked === key) {
      throw new StorageError({ code: code as 'X_STORAGE_NOT_FOUND', cause: code, fix: 'x doctor' });
    }
    return memory.get(asked, options);
  },
});

describe('deleteFenced', () => {
  test('a file a manifest names by the fence comes back, bytes and type intact', async () => {
    const disk = memoryStorageDriver();
    await disk.put(KEY_A, bytes('a'), { contentType: 'text/javascript' });
    await disk.put(manifestKey(PREFIX, 'b'), manifest('b', 1, [URL_A]));

    const deleted = await deleteFenced({ disk, prefix: PREFIX }, [KEY_A], () => true);

    expect(deleted).toBe(0);
    const read = await disk.get(KEY_A);
    expect([new TextDecoder().decode(read.bytes), read.object.contentType]).toEqual([
      'a',
      'text/javascript',
    ]);
  });

  test('a manifest the predicate does not count keeps nothing', async () => {
    const disk = memoryStorageDriver();
    await disk.put(KEY_A, bytes('a'));
    await disk.put(manifestKey(PREFIX, 'old'), manifest('old', 1, [URL_A]));

    expect(await deleteFenced({ disk, prefix: PREFIX }, [KEY_A], () => false)).toBe(1);
    expect(await disk.exists(KEY_A)).toBe(false);
  });

  test('a fence that cannot parse a manifest puts the chunk back whole', async () => {
    const disk = memoryStorageDriver();
    await disk.put(KEY_A, bytes('a'));
    await disk.put(manifestKey(PREFIX, 'torn'), bytes('{'));

    expect(await deleteFenced({ disk, prefix: PREFIX }, [KEY_A], () => true)).toBe(0);
    expect(await disk.exists(KEY_A)).toBe(true);
  });

  test('a file too large to hold is spared, one already gone is skipped', async () => {
    const memory = memoryStorageDriver();
    await memory.put(KEY_A, bytes('a'));
    const gone = retainedFileKey(PREFIX, '/islands/g-22222222.js');
    const disk = refusing(memory, KEY_A, 'X_STORAGE_TOO_LARGE');

    expect(await deleteFenced({ disk, prefix: PREFIX }, [KEY_A, gone], () => true)).toBe(0);
    expect(await memory.exists(KEY_A)).toBe(true);
  });

  test('any other refusal to read stops the sweep before a delete', async () => {
    const memory = memoryStorageDriver();
    await memory.put(KEY_A, bytes('a'));
    const disk = refusing(memory, KEY_A, 'X_STORAGE_READ_FAILED');

    await expect(deleteFenced({ disk, prefix: PREFIX }, [KEY_A], () => true)).rejects.toMatchObject(
      {
        code: 'X_STORAGE_READ_FAILED',
      },
    );
    expect(await memory.exists(KEY_A)).toBe(true);
  });
});

describe('deleteManifestIfUnchanged', () => {
  const key = manifestKey(PREFIX, 'old');

  test('deleted while it holds the date it was dropped at', async () => {
    const disk = memoryStorageDriver();
    await disk.put(key, manifest('old', 1, []));
    await deleteManifestIfUnchanged({ disk, prefix: PREFIX }, key, 1);
    expect(await disk.exists(key)).toBe(false);
  });

  test('kept once re-dated, or no longer parseable', async () => {
    const disk = memoryStorageDriver();
    await disk.put(key, manifest('old', 2, []));
    await deleteManifestIfUnchanged({ disk, prefix: PREFIX }, key, 1);
    expect(await disk.exists(key)).toBe(true);
    await disk.put(key, bytes('{'));
    await deleteManifestIfUnchanged({ disk, prefix: PREFIX }, key, 1);
    expect(await disk.exists(key)).toBe(true);
  });

  test('already gone is nothing to do; any other refusal is thrown', async () => {
    const memory = memoryStorageDriver();
    await deleteManifestIfUnchanged({ disk: memory, prefix: PREFIX }, key, 1);
    const disk = refusing(memory, key, 'X_STORAGE_READ_FAILED');
    await expect(deleteManifestIfUnchanged({ disk, prefix: PREFIX }, key, 1)).rejects.toMatchObject(
      {
        code: 'X_STORAGE_READ_FAILED',
      },
    );
  });
});
