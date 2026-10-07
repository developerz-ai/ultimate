// The local disk and the memory disk that stands in for it, held to ONE answer where they used to
// differ: which keys collide, what deleting a key that is only a directory means, and the
// `lastModified` a write reports beside the one every later read reports — under an injected clock.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`.
import { tmpdir } from 'node:os';
import { type FrozenClock, frozenClock, isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { bytesOf, catchError, textOf } from './driver-s3-fixture';

const conflictOf = (caught: unknown): string =>
  isUltimateError(caught) && caught.code === 'X_STORAGE_KEY_CONFLICT'
    ? String(caught.meta?.['blocking'])
    : `not a key conflict: ${String(caught)}`;

let root = '';
let clock: FrozenClock;
let pair: readonly (readonly [string, StorageDriver])[];

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-local-memory-`);
  clock = frozenClock('2026-10-01T09:00:00.000Z');
  pair = [
    ['local', localDriver({ root, signingSecret: 'test-secret', clock })],
    ['memory', memoryStorageDriver({ signingSecret: 'test-secret', clock })],
  ];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a key that is a path prefix of another key', () => {
  test('both disks refuse it, naming the same key in the way', async () => {
    for (const [name, disk] of pair) {
      await disk.put('a', bytesOf('file'));
      await disk.put('c/d', bytesOf('nested'));
      await disk.put('src', bytesOf('copy-me'));
      await disk.put('s', bytesOf('sidecar-tree'));
      expect([
        name,
        conflictOf(await catchError(() => disk.put('a/b', bytesOf('x')))),
        conflictOf(await catchError(() => disk.put('a/b/c', bytesOf('x')))),
        conflictOf(await catchError(() => disk.put('c', bytesOf('x')))),
        conflictOf(await catchError(() => disk.copy('c/d', 'c'))),
        conflictOf(await catchError(() => disk.copy('src', 'a/b'))),
        // `s`'s sidecar is `.meta/s.json` on the local disk, so `s.json/x`'s needs it as a directory.
        conflictOf(await catchError(() => disk.put('s.json/x', bytesOf('x')))),
      ]).toEqual([name, 'a', 'a', 'c/', 'c/', 'a', 's']);
      expect([name, textOf((await disk.get('a')).bytes), await disk.exists('c')]).toEqual([
        name,
        'file',
        false,
      ]);
    }
  });

  test('the sidecar-tree collision in the other order, and an overwrite stays legal', async () => {
    for (const [name, disk] of pair) {
      await disk.put('t.json/x', bytesOf('nested'));
      // `u`'s pending marker is `.meta/u.json.pending`, a directory once this key's sidecar is in it.
      await disk.put('u.json.pending/x', bytesOf('nested'));
      await disk.put('a', bytesOf('one'));
      await disk.put('a', bytesOf('two'));
      expect([
        name,
        conflictOf(await catchError(() => disk.put('t', bytesOf('x')))),
        conflictOf(await catchError(() => disk.put('u', bytesOf('x')))),
        textOf((await disk.get('a')).bytes),
      ]).toEqual([name, 't.json/', 'u.json.pending/', 'two']);
    }
  });

  test('a key freed by delete() can take the other shape', async () => {
    for (const [name, disk] of pair) {
      await disk.put('a', bytesOf('file'));
      await disk.delete('a');
      await disk.put('a/b', bytesOf('nested'));
      expect([name, textOf((await disk.get('a/b')).bytes)]).toEqual([name, 'nested']);
    }
  });
});

describe('deleting a key that is only another key’s directory', () => {
  test('is deleting an absent key — not an error, and nothing beneath it is touched', async () => {
    for (const [name, disk] of pair) {
      await disk.put('c/d', bytesOf('nested'));
      await disk.put('k.json/x', bytesOf('sidecar-dir'));
      const refused = await disk.delete('c').then(
        () => 'resolved',
        (caught: unknown) => (isUltimateError(caught) ? caught.code : String(caught)),
      );
      const refusedSidecar = await disk.delete('k').then(
        () => 'resolved',
        (caught: unknown) => (isUltimateError(caught) ? caught.code : String(caught)),
      );
      expect([
        name,
        refused,
        refusedSidecar,
        textOf((await disk.get('c/d')).bytes),
        textOf((await disk.get('k.json/x')).bytes),
      ]).toEqual([name, 'resolved', 'resolved', 'nested', 'sidecar-dir']);
    }
  });
});

describe('lastModified under an injected clock', () => {
  test('a write reports the instant every later read of the object reports', async () => {
    for (const [name, disk] of pair) {
      const written = clock.now().getTime();
      const at = (ms: number): string => new Date(written + ms).toISOString();
      const put = await disk.put('o/p', bytesOf('x'));
      clock.advance(60_000);
      const copied = await disk.copy('o/p', 'o/q');
      clock.advance(60_000);
      const answers = async (key: string): Promise<readonly (string | undefined)[]> => [
        (await disk.stat(key))?.lastModified?.toISOString(),
        (await disk.get(key)).object.lastModified?.toISOString(),
        (await disk.list({ prefix: key })).objects[0]?.lastModified?.toISOString(),
      ];
      expect([
        name,
        put.lastModified?.toISOString(),
        await answers('o/p'),
        copied.lastModified?.toISOString(),
        await answers('o/q'),
      ]).toEqual([name, at(0), Array(3).fill(at(0)), at(60_000), Array(3).fill(at(60_000))]);
    }
  });
});
