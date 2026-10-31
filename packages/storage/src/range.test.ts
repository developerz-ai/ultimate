// `get(key, { range })` on all three disks in ONE test per claim — memory, local over a temp dir,
// and s3 over `FakeS3Client` — so no disk can serve a different slice, clamp differently or refuse
// differently from the other two. The s3 half also proves the read was RANGED on the wire.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FakeS3Client, textOf } from './driver-s3-fixture';
import type { ByteRange } from './range';

const KEY = 'org/org-1/log.ndjson';
const TEXT = '0123456789';

let root = '';
let fake: FakeS3Client;
let disks: readonly (readonly [string, StorageDriver])[] = [];

const anyCodeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

/** Every disk, the same object written to each, with a `get()` ceiling of six bytes. */
async function seeded(maxGetBytes = 6): Promise<void> {
  root = await mkdtemp(`${tmpdir()}/ultimate-range-`);
  fake = new FakeS3Client();
  disks = [
    ['memory', memoryStorageDriver({ maxGetBytes })],
    ['local', localDriver({ root, signingSecret: 'test-secret', maxGetBytes })],
    ['s3', s3Driver({ bucket: 'b', client: fake, maxGetBytes })],
  ];
  for (const [, disk] of disks) {
    await disk.put(KEY, bytesOf(TEXT), { contentType: 'application/x-ndjson' });
  }
}

beforeEach(() => seeded());

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('get(key, { range }) — inclusive first and last byte', () => {
  test('every disk answers the same window, the served range and the WHOLE object', async () => {
    for (const [name, disk] of disks) {
      const read = await disk.get(KEY, { range: [2, 5] });
      expect([name, textOf(read.bytes)]).toEqual([name, '2345']);
      expect([name, read.range]).toEqual([name, [2, 5]]);
      // The description is the object's, so a route can write `Content-Range: bytes 2-5/10`.
      expect([name, read.object.size, read.object.contentType]).toEqual([
        name,
        10,
        'application/x-ndjson',
      ]);
    }
    // Only the window crossed the wire: `slice` is end-EXCLUSIVE, Bun turns it into `Range:`.
    expect(fake.sliceCalls).toEqual([{ key: KEY, begin: 2, end: 6 }]);
  });

  test('a single byte, and the last byte clamped to the object as HTTP clamps it', async () => {
    for (const [name, disk] of disks) {
      expect([name, textOf((await disk.get(KEY, { range: [0, 0] })).bytes)]).toEqual([name, '0']);
      const tail = await disk.get(KEY, { range: [7, 1_000_000] });
      expect([name, textOf(tail.bytes), tail.range]).toEqual([name, '789', [7, 9]]);
    }
  });

  test('a plain get() still answers no range, so a slice is never mistaken for the object', async () => {
    await rm(root, { recursive: true, force: true });
    await seeded(100);
    for (const [name, disk] of disks) {
      const read = await disk.get(KEY);
      expect([name, textOf(read.bytes), read.range]).toEqual([name, TEXT, undefined]);
    }
    expect(fake.sliceCalls).toEqual([]);
  });
});

describe('the ceiling bounds the RANGE, not the object', () => {
  test('a 10-byte object over a 6-byte ceiling is refused whole and readable in pages', async () => {
    for (const [name, disk] of disks) {
      expect([name, anyCodeOf(await catchError(() => disk.get(KEY)))]).toEqual([
        name,
        'X_STORAGE_TOO_LARGE',
      ]);
      const pages = [
        await disk.get(KEY, { range: [0, 5] }),
        await disk.get(KEY, { range: [6, 11] }),
      ];
      expect([name, pages.map((page) => textOf(page.bytes)).join('')]).toEqual([name, TEXT]);
    }
  });

  test('a range longer than the ceiling is refused before a byte is read, naming the range', async () => {
    for (const [name, disk] of disks) {
      const caught = await catchError(() => disk.get(KEY, { range: [0, 8] }));
      expect([name, anyCodeOf(caught)]).toEqual([name, 'X_STORAGE_TOO_LARGE']);
      expect(isUltimateError(caught) && caught.fix).toStartWith(
        `await disk.get("${KEY}", { range: [0, 5] })`,
      );
    }
    expect(fake.sliceCalls).toEqual([]);
  });
});

describe('refusals', () => {
  test('a first byte at or past the end is X_STORAGE_RANGE_UNSATISFIABLE on every disk', async () => {
    for (const [name, disk] of disks) {
      for (const first of [10, 11, 50]) {
        const caught = await catchError(() => disk.get(KEY, { range: [first, first + 2] }));
        expect([name, first, anyCodeOf(caught)]).toEqual([
          name,
          first,
          'X_STORAGE_RANGE_UNSATISFIABLE',
        ]);
        expect(isUltimateError(caught) && caught.meta).toMatchObject({ size: 10, first });
        expect(isUltimateError(caught) && caught.fix).toStartWith(
          `await disk.get("${KEY}", { range: [0, 9] })`,
        );
      }
    }
  });

  test('an empty object has no first byte to serve', async () => {
    for (const [name, disk] of disks) {
      await disk.put('org/org-1/empty', new Uint8Array(), { contentType: 'text/plain' });
      const caught = await catchError(() => disk.get('org/org-1/empty', { range: [0, 0] }));
      expect([name, anyCodeOf(caught)]).toEqual([name, 'X_STORAGE_RANGE_UNSATISFIABLE']);
      // Not `[0, 0]` again, which is the same 416: the plain read of an empty object.
      expect(isUltimateError(caught) && caught.fix).toStartWith(
        'await disk.get("org/org-1/empty")   #',
      );
    }
  });

  test('a backwards, negative, fractional or malformed range is the CALLER’s defect', async () => {
    const bad: readonly unknown[] = [[5, 2], [-1, 3], [0.5, 3], [0], [0, 1, 2], '0-3', [0, '3']];
    for (const [name, disk] of disks) {
      for (const range of bad) {
        // The untyped caller this screen exists for: a JS file or a route that copied a header.
        const options = { range } as unknown as { range: ByteRange };
        expect([name, range, anyCodeOf(await catchError(() => disk.get(KEY, options)))]).toEqual([
          name,
          range,
          'X_INVARIANT',
        ]);
      }
    }
  });

  test('an absent key is X_STORAGE_NOT_FOUND, not a range refusal', async () => {
    for (const [name, disk] of disks) {
      const caught = await catchError(() => disk.get('org/org-1/nope', { range: [0, 1] }));
      expect([name, anyCodeOf(caught)]).toEqual([name, 'X_STORAGE_NOT_FOUND']);
    }
  });
});

describe('s3: an object that changes between the HEAD and the ranged GET', () => {
  const s3Of = (): StorageDriver => disks.find(([name]) => name === 's3')?.[1] as StorageDriver;
  const rewrite = (text: string) => {
    let once = true;
    fake.beforeRangeRead = (key) => {
      if (!once) return;
      once = false;
      fake.store.set(key, { bytes: bytesOf(text), type: 'application/x-ndjson' });
    };
  };

  test('shrunk: the served range and the size are the object the bytes came from', async () => {
    rewrite('01234567');
    const read = await s3Of().get(KEY, { range: [7, 9] });
    expect([textOf(read.bytes), read.range, read.object.size]).toEqual(['7', [7, 7], 8]);
  });

  test('grown: the size is re-read, never the stale HEAD', async () => {
    rewrite('0123456789AB');
    const read = await s3Of().get(KEY, { range: [8, 11] });
    expect([textOf(read.bytes), read.range, read.object.size]).toEqual(['89AB', [8, 11], 12]);
  });

  test('shrunk past the first byte asked: the 416 the new object owes', async () => {
    rewrite('0123');
    const caught = await catchError(() => s3Of().get(KEY, { range: [6, 9] }));
    expect(anyCodeOf(caught)).toBe('X_STORAGE_RANGE_UNSATISFIABLE');
  });

  test('a writer that never stops: X_STORAGE_READ_FAILED, never a slice of an unknown object', async () => {
    let n = 0;
    fake.beforeRangeRead = (key) => {
      n += 1;
      fake.store.set(key, { bytes: bytesOf('x'.repeat(10 + n)), type: 'text/plain' });
    };
    const caught = await catchError(() => s3Of().get(KEY, { range: [0, 3] }));
    expect(anyCodeOf(caught)).toBe('X_STORAGE_READ_FAILED');
  });
});
