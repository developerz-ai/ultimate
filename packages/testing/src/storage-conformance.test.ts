// The storage conformance suite over the memory and the local disk, and the proof it can fail: a
// disk whose `stream` drops the etag pin, and one whose `list` ignores the cursor — both compile.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; the local disk needs a real one.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask where the platform's is.
import { tmpdir } from 'node:os';
import { frozenClock } from '@ultimat3/core';
import { localDriver, memoryStorageDriver } from '@ultimat3/storage';
import { behavesLike } from './shared-examples';
import { STORAGE_DRIVER_CHECKS, storageDriverConformance } from './storage-conformance';
import type { StorageDriverLike } from './storage-conformance-shape';
import { testName } from './test-types';

const clock = frozenClock('2026-07-26T12:00:00.000Z');
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Small enough that a streamed body past it proves `putStream` is not capped by it. */
const maxPutBytes = 64;

describe(testName('unit', 'the memory storage driver'), () => {
  behavesLike(storageDriverConformance, () => ({
    disk: memoryStorageDriver({ signingSecret: 'test-secret', clock, maxPutBytes }),
    maxPutBytes,
  }));
});

describe(testName('unit', 'the local storage driver'), () => {
  behavesLike(storageDriverConformance, async () => {
    const root = await mkdtemp(`${tmpdir()}/ultimate-storage-conformance-`);
    roots.push(root);
    return {
      disk: localDriver({ root, signingSecret: 'test-secret', clock, maxPutBytes }),
      maxPutBytes,
    };
  });
});

const check = (name: string) => {
  const found = STORAGE_DRIVER_CHECKS.find((each) => each.name.startsWith(name));
  if (found === undefined) return expect.unreachable(`no conformance check named ${name}`);
  return found;
};

const memory = (): StorageDriverLike => memoryStorageDriver({ signingSecret: 's', clock });

describe(testName('unit', 'a disk that breaks the contract fails conformance'), () => {
  test('a stream that serves whatever revision is there, pinned or not', async () => {
    const inner = memory();
    const unpinned: StorageDriverLike = { ...inner, stream: (key) => inner.stream(key) };
    const pinned = check('an overwrite moves the etag');
    await expect(pinned.run({ disk: unpinned })).rejects.toThrow();
    await pinned.run({ disk: memory() });
  });

  test('a list that answers the first page for every cursor', async () => {
    const inner = memory();
    const stuck: StorageDriverLike = {
      ...inner,
      list: (options) => inner.list({ ...options, cursor: null }),
    };
    const paging = check('list pages through every key');
    await expect(paging.run({ disk: stuck })).rejects.toThrow();
    await paging.run({ disk: memory() });
  });

  test('a putStream that drops cacheControl and metadata', async () => {
    const inner = memory();
    const forgetful: StorageDriverLike = {
      ...inner,
      putStream: (key, stream, options) =>
        inner.putStream(key, stream, {
          maxBytes: options.maxBytes,
          contentType: options.contentType,
        }),
    };
    const roundTrip = check('putStream round-trips');
    await expect(roundTrip.run({ disk: forgetful })).rejects.toThrow();
    await roundTrip.run({ disk: memory() });
  });

  test('a putStream that buffers through put(), so the put ceiling caps it', async () => {
    const inner = memoryStorageDriver({ signingSecret: 's', clock, maxPutBytes: 8 });
    const buffered: StorageDriverLike = {
      ...inner,
      putStream: async (key, stream) =>
        inner.put(key, new Uint8Array(await new Response(stream).arrayBuffer())),
    };
    const ceiling = check('putStream is bounded by its own maxBytes');
    await expect(ceiling.run({ disk: buffered, maxPutBytes: 8 })).rejects.toThrow();
    await ceiling.run({ disk: inner, maxPutBytes: 8 });
  });

  test('a putStream that skips the screen and takes any option and any body', async () => {
    const inner = memory();
    const unscreened: StorageDriverLike = {
      ...inner,
      putStream: (key, stream) => inner.putStream(key, stream, { maxBytes: 1024 }),
    };
    const screen = check('putStream screens maxBytes');
    await expect(screen.run({ disk: unscreened })).rejects.toThrow();
    await screen.run({ disk: memory() });
  });

  test('a streamRange that skips the key check', async () => {
    const inner = memory();
    const unsafe: StorageDriverLike = {
      ...inner,
      streamRange: (key, range, options) =>
        key.startsWith('..')
          ? Promise.resolve(new Blob([]).stream())
          : inner.streamRange(key, range, options),
    };
    const tuple = check('a tuple that is no range');
    await expect(tuple.run({ disk: unsafe })).rejects.toThrow();
    await tuple.run({ disk: memory() });
  });

  test('every check has a name of its own', () => {
    const names = STORAGE_DRIVER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
