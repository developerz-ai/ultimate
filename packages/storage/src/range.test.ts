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
import {
  bytesOf,
  catchError,
  FAKE_ENV,
  FakeS3Client,
  fakeEtagOf,
  textOf,
} from './driver-s3-fixture';
import type { ByteRange } from './range';

const KEY = 'org/org-1/log.ndjson';
const TEXT = '0123456789';

let root = '';
let fake: FakeS3Client;
let disks: readonly (readonly [string, StorageDriver])[] = [];

/** The `Range:` of every signed GET the s3 disk sent. */
const rangedGets = (): readonly string[] =>
  fake.signedCalls.flatMap((call) =>
    call.method === 'GET' && call.headers['range'] !== undefined ? [call.headers['range']] : [],
  );

const anyCodeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

/** Every disk, the same object written to each, with a `get()` ceiling of six bytes. */
async function seeded(maxGetBytes = 6): Promise<void> {
  root = await mkdtemp(`${tmpdir()}/ultimate-range-`);
  fake = new FakeS3Client();
  disks = [
    ['memory', memoryStorageDriver({ maxGetBytes })],
    ['local', localDriver({ root, signingSecret: 'test-secret', maxGetBytes })],
    ['s3', s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV, maxGetBytes })],
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
    // ONE request crossed the wire, and it asked for the window only.
    expect(rangedGets()).toEqual(['bytes=2-5']);
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
    expect(rangedGets()).toEqual([]);
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
    // s3 learns the size from the answer, so it asks for at most the ceiling, never the range.
    expect(rangedGets()).toEqual(['bytes=0-5']);
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

describe('s3: the bytes and what they are come from ONE response', () => {
  const s3Of = (): StorageDriver => disks.find(([name]) => name === 's3')?.[1] as StorageDriver;
  const rewrite = (text: string) => {
    let once = true;
    fake.beforeRangeRead = (key) => {
      if (!once) return;
      once = false;
      fake.store.set(key, { bytes: bytesOf(text), type: 'application/x-ndjson' });
    };
  };

  test('no HEAD beside the GET: one request, whose Content-Range and ETag describe the bytes', async () => {
    fake.fileCalls.length = 0;
    const read = await s3Of().get(KEY, { range: [2, 5] });
    expect(fake.fileCalls).toEqual([]);
    expect(read.object.etag).toBe(fakeEtagOf({ bytes: bytesOf(TEXT) }));
  });

  test('shrunk before the GET: the served range and the size are the object the bytes came from', async () => {
    rewrite('01234567');
    const read = await s3Of().get(KEY, { range: [7, 9] });
    expect([textOf(read.bytes), read.range, read.object.size]).toEqual(['7', [7, 7], 8]);
  });

  test('grown before the GET: the size is the answer’s, never a stale HEAD’s', async () => {
    rewrite('0123456789AB');
    const read = await s3Of().get(KEY, { range: [8, 11] });
    expect([textOf(read.bytes), read.range, read.object.size]).toEqual(['89AB', [8, 11], 12]);
  });

  test('shrunk past the first byte asked: the provider’s 416 is X_STORAGE_RANGE_UNSATISFIABLE', async () => {
    rewrite('0123');
    const caught = await catchError(() => s3Of().get(KEY, { range: [6, 9] }));
    expect(anyCodeOf(caught)).toBe('X_STORAGE_RANGE_UNSATISFIABLE');
    expect(isUltimateError(caught) && caught.meta).toMatchObject({ size: 4, first: 6 });
  });

  test('A → B → A of one length: the bytes served carry THEIR etag, never the other version’s', async () => {
    fake.store.set(KEY, { bytes: bytesOf(TEXT), etag: '"version-a"' });
    const before = await s3Of().stat(KEY);
    rewrite('abcdefghij');
    const read = await s3Of().get(KEY, { range: [0, 3] });
    expect(textOf(read.bytes)).toBe('abcd');
    expect(read.object.etag).toBe(fakeEtagOf({ bytes: bytesOf('abcdefghij') }));
    expect(before?.etag).toBe('"version-a"');
    expect(read.object.etag).not.toBe(before?.etag);
  });

  test('a provider refusal is coded: 404 not found, 403 READ_FAILED', async () => {
    fake.store.delete(KEY);
    expect(anyCodeOf(await catchError(() => s3Of().get(KEY, { range: [0, 1] })))).toBe(
      'X_STORAGE_NOT_FOUND',
    );
    await s3Of().put(KEY, bytesOf(TEXT));
    fake.failReadWith = Object.assign(new Error('denied'), {
      code: 'AccessDenied',
      statusCode: 403,
    });
    expect(anyCodeOf(await catchError(() => s3Of().get(KEY, { range: [0, 1] })))).toBe(
      'X_STORAGE_READ_FAILED',
    );
  });
});
