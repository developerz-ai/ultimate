// The read-and-write half of the `StorageDriver` contract: what every disk — local, memory, s3, and
// yours — answers through the port alone. Lifted from `storage/src/driver-contract.test.ts` and
// `driver-parity.test.ts`; a semantic only one disk holds is a test that passes CI and fails deploy.

import { expect } from 'bun:test';
import type { StorageCheck } from './storage-conformance-shape';
import { bytesOf, drain, refusalOf, scopeOf, streamOf, textOf } from './storage-conformance-shape';

export const STORAGE_READ_CHECKS: readonly StorageCheck[] = [
  {
    name: 'put, stat, get and exists describe one object: key, size and type',
    async run({ disk }) {
      const key = `${scopeOf()}a.png`;
      const put = await disk.put(key, bytesOf('12345'), { contentType: 'image/png' });
      const stat = await disk.stat(key);
      const read = await disk.get(key);
      for (const object of [put, stat, read.object]) {
        expect([object?.key, object?.size, object?.contentType]).toEqual([key, 5, 'image/png']);
      }
      expect(textOf(read.bytes)).toBe('12345');
      expect(await disk.exists(key)).toBe(true);
    },
  },
  {
    name: 'an absent key is undefined to stat, false to exists, X_STORAGE_NOT_FOUND to a read',
    async run({ disk }) {
      const scope = scopeOf();
      await disk.put(`${scope}p`, bytesOf('file'));
      await disk.put(`${scope}q/r`, bytesOf('nested'));
      // `p/x` sits under an object and `q` is only a prefix: absent on every disk all the same.
      for (const absent of [`${scope}never`, `${scope}p/x`, `${scope}q`]) {
        expect(await disk.stat(absent)).toBeUndefined();
        expect(await disk.exists(absent)).toBe(false);
        expect(await refusalOf(() => disk.get(absent))).toBe('X_STORAGE_NOT_FOUND');
        expect(await refusalOf(() => disk.stream(absent))).toBe('X_STORAGE_NOT_FOUND');
        expect(await refusalOf(() => disk.streamRange(absent, [0, 1]))).toBe('X_STORAGE_NOT_FOUND');
      }
      expect(textOf((await disk.get(`${scope}q/r`)).bytes)).toBe('nested');
    },
  },
  {
    name: 'a key that climbs out of the disk is X_STORAGE_PATH_UNSAFE before a byte moves',
    async run({ disk }) {
      expect(await refusalOf(() => disk.stat('../escape'))).toBe('X_STORAGE_PATH_UNSAFE');
      expect(await refusalOf(() => disk.get('../escape'))).toBe('X_STORAGE_PATH_UNSAFE');
      expect(await refusalOf(() => disk.put('../escape', bytesOf('x')))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
    },
  },
  {
    name: 'an overwrite moves the etag, and a read pinned to the old one is X_STORAGE_OBJECT_CHANGED',
    async run({ disk }) {
      const key = `${scopeOf()}v.txt`;
      await disk.put(key, bytesOf('first version'), { contentType: 'text/plain' });
      const before = (await disk.stat(key))?.etag ?? '';
      await disk.put(key, bytesOf('second, longer version'), { contentType: 'text/plain' });
      const now = (await disk.stat(key))?.etag ?? '';
      expect(now).not.toBe(before);
      const stale = { etag: before };
      expect(await refusalOf(() => disk.stream(key, stale))).toBe('X_STORAGE_OBJECT_CHANGED');
      expect(await refusalOf(() => disk.streamRange(key, [0, 4], stale))).toBe(
        'X_STORAGE_OBJECT_CHANGED',
      );
      expect(await drain(await disk.stream(key, { etag: now }))).toBe('second, longer version');
      expect(await drain(await disk.streamRange(key, [0, 5], { etag: now }))).toBe('second');
    },
  },
  {
    name: 'a header value with a line break is X_INVARIANT on put and putStream, and stores nothing',
    async run({ disk }) {
      const key = `${scopeOf()}a`;
      const injected = 'text/html\r\nx-evil: 1';
      for (const options of [{ contentType: injected }, { cacheControl: injected }]) {
        expect(await refusalOf(() => disk.put(key, bytesOf('x'), options))).toBe('X_INVARIANT');
        const streamed = () =>
          disk.putStream(key, streamOf(bytesOf('x')), { maxBytes: 8, ...options });
        expect(await refusalOf(streamed)).toBe('X_INVARIANT');
      }
      expect(await disk.exists(key)).toBe(false);
    },
  },
  {
    name: 'delete of an absent key resolves, and a deleted key reads as absent',
    async run({ disk }) {
      const key = `${scopeOf()}gone.txt`;
      await expect(disk.delete(key)).resolves.toBeUndefined();
      await disk.put(key, bytesOf('x'));
      await disk.delete(key);
      expect(await disk.exists(key)).toBe(false);
      expect(await refusalOf(() => disk.get(key))).toBe('X_STORAGE_NOT_FOUND');
    },
  },
  {
    name: 'metadata and cacheControl put() was told are on the object it answers',
    async run({ disk }) {
      const options = { cacheControl: 'public, max-age=60', metadata: { uploadedBy: 'user-1' } };
      const object = await disk.put(`${scopeOf()}m`, bytesOf('x'), options);
      expect([object.cacheControl, object.metadata]).toEqual([
        'public, max-age=60',
        { uploadedBy: 'user-1' },
      ]);
    },
  },
  {
    name: 'copy lands the bytes at the destination and leaves the source as it was',
    async run({ disk }) {
      const scope = scopeOf();
      const source = await disk.put(`${scope}src`, bytesOf('copy-me'), {
        contentType: 'text/plain',
      });
      const copied = await disk.copy(`${scope}src`, `${scope}dst`, { ifMatch: source.etag });
      expect([copied.key, copied.size]).toEqual([`${scope}dst`, 7]);
      expect(textOf((await disk.get(`${scope}dst`)).bytes)).toBe('copy-me');
      expect(textOf((await disk.get(`${scope}src`)).bytes)).toBe('copy-me');
      expect(await refusalOf(() => disk.copy(`${scope}none`, `${scope}x`))).toBe(
        'X_STORAGE_NOT_FOUND',
      );
    },
  },
  {
    name: 'a copy pinned to a revision the source moved past is refused and writes nothing',
    async run({ disk }) {
      const scope = scopeOf();
      const old = await disk.put(`${scope}src`, bytesOf('one'));
      await disk.put(`${scope}src`, bytesOf('two, longer'));
      const stale = () => disk.copy(`${scope}src`, `${scope}dst`, { ifMatch: old.etag });
      expect(await refusalOf(stale)).toBe('X_STORAGE_OBJECT_CHANGED');
      expect(await disk.exists(`${scope}dst`)).toBe(false);
    },
  },
];
