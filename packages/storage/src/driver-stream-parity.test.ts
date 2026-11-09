// `streamRange` and `putStream`, one claim per test, on all three disks at once (the rule
// `driver-parity.test.ts` states): the s3 disk runs over `FakeS3Client`, so its wire shape is what
// `driver-s3-put-stream.test.ts` and the live suite prove, and this file proves the contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`.
import { tmpdir } from 'node:os';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, textOf } from './driver-s3-fixture';
import { META_DIR } from './path';

const KEY = 'org/org-1/a.bin';
const clock = frozenClock('2026-07-26T12:00:00.000Z');
const anyCode = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let disks: readonly StorageDriver[] = [];
let local: StorageDriver;

const streamOf = (...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

const stagedFiles = async (): Promise<readonly string[]> =>
  readdir(`${root}/${META_DIR}/.tmp`).catch(() => []);

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-stream-parity-`);
  const fake = new FakeS3Client();
  local = localDriver({ root, signingSecret: 'test-secret', clock, maxPutBytes: 8 });
  disks = [
    local,
    s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV, maxPutBytes: 8 }),
    memoryStorageDriver({ signingSecret: 'test-secret', clock, maxPutBytes: 8 }),
  ];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('streamRange(key, [first, last])', () => {
  test('the window is the bytes get() answers for the same range, on every disk', async () => {
    const big = localDriver({ root: `${root}/big`, signingSecret: 's', clock });
    const fake = new FakeS3Client();
    const body = bytesOf('0123456789');
    for (const disk of [
      big,
      s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV }),
      memoryStorageDriver(),
    ]) {
      await disk.put(KEY, body);
      for (const range of [
        [0, 0],
        [2, 5],
        [9, 9],
      ] as const) {
        const window = await drain(await disk.streamRange(KEY, range));
        expect(textOf(window)).toBe(textOf((await disk.get(KEY, { range })).bytes));
      }
      // Clamped as HTTP clamps it, and as `get` does.
      expect(textOf(await drain(await disk.streamRange(KEY, [7, 1_000_000])))).toBe('789');
    }
  });

  test('past the end is the 416 code, absent is the 404 code, on every disk', async () => {
    const big = localDriver({ root: `${root}/big`, signingSecret: 's', clock });
    const fake = new FakeS3Client();
    for (const disk of [
      big,
      s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV }),
      memoryStorageDriver(),
    ]) {
      expect(anyCode(await catchError(() => disk.streamRange(KEY, [0, 1])))).toBe(
        'X_STORAGE_NOT_FOUND',
      );
      await disk.put(KEY, bytesOf('abc'));
      const refused = await catchError(() => disk.streamRange(KEY, [3, 9]));
      expect(anyCode(refused)).toBe('X_STORAGE_RANGE_UNSATISFIABLE');
      expect((refused as { fix: string }).fix).toContain('disk.stat(');
    }
  });

  test('a tuple that is no range is refused before the disk is asked', async () => {
    for (const disk of disks) {
      for (const range of [[5, 2], [-1, 2], [0.5, 2], [0], 'bytes=0-1']) {
        const refused = await catchError(() =>
          disk.streamRange(KEY, range as unknown as readonly [number, number]),
        );
        expect(anyCode(refused)).toBe('X_INVARIANT');
        expect((refused as { cause: string }).cause).toContain('streamRange()');
      }
      expect(anyCode(await catchError(() => disk.streamRange('../up', [0, 1])))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
    }
  });

  test('the local disk pulls only the window out of a large object', async () => {
    const huge = new Uint8Array(32 * 1024 * 1024);
    const big = localDriver({ root: `${root}/big`, signingSecret: 's', clock });
    await big.putStream(KEY, streamOf(huge), { maxBytes: huge.byteLength });
    let pulled = 0;
    for await (const chunk of await big.streamRange(KEY, [huge.byteLength - 10, huge.byteLength])) {
      pulled += chunk.byteLength;
    }
    expect(pulled).toBe(10);
  });
});

describe('putStream(key, stream, { maxBytes })', () => {
  test('round-trips a body past maxPutBytes, in the one object shape put() answers', async () => {
    for (const disk of disks) {
      const object = await disk.putStream(KEY, streamOf(bytesOf('hello '), bytesOf('stream')), {
        maxBytes: 64,
        contentType: 'text/plain',
        cacheControl: 'public, max-age=60',
        metadata: { uploadedBy: 'user-1' },
      });
      expect(object.key).toBe(KEY);
      expect(object.size).toBe(12);
      expect(object.contentType).toBe('text/plain');
      expect(object.cacheControl).toBe('public, max-age=60');
      expect(object.metadata).toEqual({ uploadedBy: 'user-1' });
      expect(textOf(await drain(await disk.stream(KEY)))).toBe('hello stream');
      expect((await disk.stat(KEY))?.size).toBe(12);
    }
  });

  test('a body across several write batches lands every chunk, in order', async () => {
    // The local disk flushes per MiB, not per chunk: 3 MiB in 256 KiB chunks crosses the line
    // twice and ends mid-batch, so a lost or reordered batch shows as a wrong first byte.
    const size = 256 * 1024;
    const count = 12;
    for (const disk of disks) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === count) return controller.close();
          sent += 1;
          controller.enqueue(new Uint8Array(size).fill(sent));
        },
      });
      await disk.putStream(KEY, body, { maxBytes: size * count });
      const stored = await drain(await disk.stream(KEY));
      expect(`${disk.name}:${stored.byteLength}`).toBe(`${disk.name}:${size * count}`);
      for (let index = 0; index < count; index += 1) {
        expect(`${disk.name}:${stored[index * size + size - 1]}`).toBe(`${disk.name}:${index + 1}`);
      }
    }
  });

  test('the etag is the one put() would have recorded for those bytes', async () => {
    const roomy = localDriver({ root: `${root}/etag`, signingSecret: 's', clock });
    const put = await roomy.put('via-put', bytesOf('same bytes'));
    const streamed = await roomy.putStream('via-stream', streamOf(bytesOf('same bytes')), {
      maxBytes: 64,
    });
    expect(streamed.etag).toBe(put.etag);
    expect((await roomy.get('via-stream')).object.etag).toBe(put.etag);
  });

  test('an overrun is X_STORAGE_TOO_LARGE, cancels the source and leaves nothing behind', async () => {
    for (const disk of disks) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => controller.enqueue(bytesOf('0123456789')),
        cancel: () => {
          cancelled = true;
        },
      });
      const refused = await catchError(() => disk.putStream(KEY, body, { maxBytes: 16 }));
      expect(anyCode(refused)).toBe('X_STORAGE_TOO_LARGE');
      expect((refused as { fix: string }).fix).toContain('maxBytes');
      expect(cancelled).toBe(true);
      expect(await disk.exists(KEY)).toBe(false);
    }
    expect(await stagedFiles()).toEqual([]);
  });

  test('an overrun leaves the object already at the key exactly as it was', async () => {
    for (const disk of disks) {
      await disk.put(KEY, bytesOf('previous'), { contentType: 'text/plain' });
      const refused = await catchError(() =>
        disk.putStream(KEY, streamOf(bytesOf('0123456789'), bytesOf('0123456789')), {
          maxBytes: 16,
        }),
      );
      expect(anyCode(refused)).toBe('X_STORAGE_TOO_LARGE');
      expect(textOf((await disk.get(KEY)).bytes)).toBe('previous');
    }
  });

  test('a source that dies mid-body is a refused write, and leaves nothing', async () => {
    for (const disk of disks) {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new TypeError('the client went away'));
          else controller.enqueue(bytesOf('partial'));
          sent = true;
        },
      });
      const refused = await catchError(() => disk.putStream(KEY, body, { maxBytes: 64 }));
      expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
      expect(await disk.exists(KEY)).toBe(false);
    }
    expect(await stagedFiles()).toEqual([]);
  });

  test('what needs the bytes up front is refused, for a caller the type did not stop', async () => {
    for (const disk of disks) {
      for (const extra of [
        { checksum: 'abc' },
        { legalHold: true },
        { retention: { mode: 'GOVERNANCE', retainUntil: new Date(0) } },
        { serverSideEncryption: { algorithm: 'AES256' } },
      ]) {
        const options = { maxBytes: 64, ...extra } as unknown as { maxBytes: number };
        const refused = await catchError(() => disk.putStream(KEY, streamOf(), options));
        expect(anyCode(refused)).toBe('X_INVARIANT');
        expect((refused as { fix: string }).fix).toContain('disk.put(');
      }
      expect(await disk.exists(KEY)).toBe(false);
    }
  });

  test('maxBytes is required and screened, and a body must be a stream of bytes', async () => {
    for (const disk of disks) {
      for (const maxBytes of [undefined, 0, -1, 1.5, Number.NaN]) {
        const options = { maxBytes } as unknown as { maxBytes: number };
        expect(anyCode(await catchError(() => disk.putStream(KEY, streamOf(), options)))).toBe(
          'X_INVARIANT',
        );
      }
      const notAStream = bytesOf('x') as unknown as ReadableStream<Uint8Array>;
      expect(
        anyCode(await catchError(() => disk.putStream(KEY, notAStream, { maxBytes: 1 }))),
      ).toBe('X_INVARIANT');
      const text = new ReadableStream({
        start(controller) {
          controller.enqueue('not bytes');
          controller.close();
        },
      }) as unknown as ReadableStream<Uint8Array>;
      expect(anyCode(await catchError(() => disk.putStream(KEY, text, { maxBytes: 64 })))).toBe(
        'X_INVARIANT',
      );
    }
    expect(await stagedFiles()).toEqual([]);
  });

  test('metadata is held to its type before a byte moves', async () => {
    for (const disk of disks) {
      const options = { maxBytes: 64, metadata: { n: 1 } } as unknown as { maxBytes: number };
      expect(anyCode(await catchError(() => disk.putStream(KEY, streamOf(), options)))).toBe(
        'X_INVARIANT',
      );
    }
  });

  test('the local disk: a locked key and a key in the way refuse, and strand no temp file', async () => {
    const roomy = localDriver({ root, signingSecret: 's', clock });
    await roomy.put('held', bytesOf('x'), { legalHold: true });
    expect(
      anyCode(
        await catchError(() => roomy.putStream('held', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_OBJECT_LOCKED');
    await roomy.put('dir', bytesOf('x'));
    expect(
      anyCode(
        await catchError(() => roomy.putStream('dir/sub', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_KEY_CONFLICT');
    expect(await stagedFiles()).toEqual([]);
  });

  test('the memory disk refuses a key in the way as the local disk does', async () => {
    const memory = memoryStorageDriver();
    await memory.put('dir', bytesOf('x'));
    expect(
      anyCode(
        await catchError(() =>
          memory.putStream('dir/sub', streamOf(bytesOf('y')), { maxBytes: 8 }),
        ),
      ),
    ).toBe('X_STORAGE_KEY_CONFLICT');
    await memory.put('held', bytesOf('x'), { legalHold: true });
    expect(
      anyCode(
        await catchError(() => memory.putStream('held', streamOf(bytesOf('y')), { maxBytes: 8 })),
      ),
    ).toBe('X_STORAGE_OBJECT_LOCKED');
  });
});
