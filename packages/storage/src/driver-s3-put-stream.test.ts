// What `putStream` puts on the s3 wire: an ordinary signed PUT for a body that fits one part, a
// multipart upload past it, and an AbortMultipartUpload on every way out that is not a complete,
// because the object must not exist until the whole body has been accepted.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, s3Error, textOf } from './driver-s3-fixture';
import { STREAM_PART_BUFFERS, STREAM_PART_BYTES, streamPartBytes } from './driver-s3-put-stream';
import { MAX_PART_BYTES, partBytesFor } from './multipart';

const KEY = 'org/org-1/film.mp4';
const MIB = 1024 * 1024;
const anyCode = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

const chunksOf = (count: number, bytes: number): ReadableStream<Uint8Array> => {
  let left = count;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) {
        controller.close();
        return;
      }
      left -= 1;
      controller.enqueue(new Uint8Array(bytes).fill(count - left));
    },
  });
};

let fake: FakeS3Client;
let disk: StorageDriver;

const callsOf = (): readonly string[] =>
  fake.signedCalls.map(
    (call) => `${call.method} ${[...call.url.searchParams.keys()].sort().join(',')}`,
  );

beforeEach(() => {
  fake = new FakeS3Client();
  disk = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
});

describe('putStream on the s3 wire', () => {
  test('a body that fits one part is one signed PUT, and no upload is ever opened', async () => {
    await disk.putStream(KEY, chunksOf(3, 1024), { maxBytes: 64 * MIB, contentType: 'video/mp4' });
    expect(callsOf()).toEqual(['PUT ']);
    expect(fake.store.get(KEY)?.bytes.byteLength).toBe(3072);
    expect(fake.store.get(KEY)?.type).toBe('video/mp4');
  });

  test('past one part: create, parts in order, complete; the body held to one part at a time', async () => {
    const object = await disk.putStream(KEY, chunksOf(12, MIB), {
      maxBytes: 64 * MIB,
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=60',
      metadata: { run: 'r-1' },
    });
    expect(callsOf()).toEqual([
      'POST uploads',
      'PUT partNumber,uploadId',
      'PUT partNumber,uploadId',
      'POST uploadId',
    ]);
    // Every byte, in order: each part filled with its own chunk number.
    const stored = fake.store.get(KEY)?.bytes ?? new Uint8Array();
    expect(stored.byteLength).toBe(12 * MIB);
    expect(stored[0]).toBe(1);
    expect(stored[12 * MIB - 1]).toBe(12);
    expect(object.size).toBe(12 * MIB);
    // The object's headers travel on the CREATE: a part has none.
    const create = fake.signedCalls[0]?.headers ?? {};
    expect(create['content-type']).toBe('video/mp4');
    expect(create['cache-control']).toBe('public, max-age=60');
    expect(create['x-amz-meta-run']).toBe('r-1');
    expect(object.cacheControl).toBe('public, max-age=60');
    expect(object.metadata).toEqual({ run: 'r-1' });
    // Parts are cut at STREAM_PART_BYTES exactly, whatever the declared ceiling.
    const parts = fake.signedCalls.filter((call) => call.url.searchParams.has('partNumber'));
    const sizes = parts.map((call) => [
      call.url.searchParams.get('partNumber'),
      call.body?.byteLength,
    ]);
    expect(sizes.sort()).toEqual([
      ['1', 8 * MIB],
      ['2', 4 * MIB],
    ]);
  });

  test('a body ending exactly on a part sends no empty last part', async () => {
    await disk.putStream(KEY, chunksOf(8, MIB), { maxBytes: 64 * MIB });
    expect(callsOf()).toEqual(['POST uploads', 'PUT partNumber,uploadId', 'POST uploadId']);
    expect(fake.store.get(KEY)?.bytes.byteLength).toBe(8 * MIB);
  });

  test('an overrun aborts the open upload: no object, no parts left billing', async () => {
    await disk.put(KEY, bytesOf('previous'));
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(100, MIB), { maxBytes: 11 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_TOO_LARGE');
    expect(callsOf().at(-1)).toBe('DELETE uploadId');
    expect(fake.openUploads()).toEqual([]);
    expect(textOf(fake.store.get(KEY)?.bytes ?? new Uint8Array())).toBe('previous');
  });

  test('a refused part is X_STORAGE_PUT_FAILED, aborted, and the source is cancelled', async () => {
    fake.failPartWith = s3Error('SlowDown', 503, KEY);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(MIB)),
      cancel: () => {
        cancelled = true;
      },
    });
    const refused = await catchError(() => disk.putStream(KEY, body, { maxBytes: 64 * MIB }));
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
    expect(cancelled).toBe(true);
    expect(fake.openUploads()).toEqual([]);
    expect(fake.store.has(KEY)).toBe(false);
  });

  test('a complete answered 200 with an <Error> body is the refusal it says it is', async () => {
    fake.failCompleteWith = s3Error('InternalError', 200, KEY);
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(10, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
    expect((refused as { cause: string }).cause).toContain('InternalError');
    expect(fake.store.has(KEY)).toBe(false);
    expect(fake.openUploads()).toEqual([]);
  });

  test('a refused create opens nothing to abort', async () => {
    fake.failCreateWith = s3Error('AccessDenied', 403, KEY);
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(10, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
    expect(callsOf()).toEqual(['POST uploads']);
  });

  test('metadata that cannot travel as a header is refused before the body is read', async () => {
    const body = new ReadableStream<Uint8Array>();
    const refused = await catchError(() =>
      disk.putStream(KEY, body, { maxBytes: 64, metadata: { 'bad name': 'x' } }),
    );
    expect(anyCode(refused)).toBe('X_INVARIANT');
    // Never read: a reader takes the lock, and the caller still holds a usable stream.
    expect(body.locked).toBe(false);
  });
});

describe('answers with nothing to go on', () => {
  test('a Create with no UploadId and a part with no ETag are refused writes, and open nothing', async () => {
    fake.createAnswersNoId = true;
    const noId = await catchError(() =>
      disk.putStream(KEY, chunksOf(10, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(noId)).toBe('X_STORAGE_PUT_FAILED');
    expect((noId as { cause: string }).cause).toContain('CreateMultipartUpload');

    fake.createAnswersNoId = false;
    fake.partAnswersNoEtag = true;
    const noEtag = await catchError(() =>
      disk.putStream(KEY, chunksOf(10, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(noEtag)).toBe('X_STORAGE_PUT_FAILED');
    expect((noEtag as { cause: string }).cause).toContain('UploadPart');
    expect(fake.openUploads()).toEqual([]);
    expect(fake.store.has(KEY)).toBe(false);
  });

  test('a refusal this process coded before the PUT is not settled as a lost answer', async () => {
    const keyless = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: {} });
    const refused = await catchError(() =>
      keyless.putStream(KEY, chunksOf(1, 1024), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_ENV_MISSING');
    expect(fake.signedCalls).toEqual([]);
  });
});

describe('parts in flight', () => {
  test('a slow provider is sent several parts at once, never more buffers than the bound', async () => {
    let sending = 0;
    let most = 0;
    /** One event-loop turn: the pump's chance to fill and send the next part, if it would. */
    const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const slow: typeof fake.fetch = async (url, init) => {
      const part = new URL(url).searchParams.has('partNumber') && init.method === 'PUT';
      if (!part) return fake.fetch(url, init);
      sending += 1;
      most = Math.max(most, sending);
      // A provider slower than the pump, in turns not milliseconds: a part waits while the next
      // could be filled — a serial pump sends none meanwhile, and `most` stays 1.
      for (let waited = 0; waited < 200 && sending < STREAM_PART_BUFFERS; waited += 1) await turn();
      sending -= 1;
      return fake.fetch(url, init);
    };
    const slowDisk = s3Driver({ bucket: 'b', client: fake, fetch: slow, env: FAKE_ENV });
    await slowDisk.putStream(KEY, chunksOf(64, MIB), { maxBytes: 128 * MIB });
    expect(most).toBeGreaterThan(1);
    // In flight plus the one filling: never more than STREAM_PART_BUFFERS parts held, so at most
    // that many sending (the last, with nothing left to fill).
    expect(most).toBeLessThanOrEqual(STREAM_PART_BUFFERS);
    expect(fake.store.get(KEY)?.bytes.byteLength).toBe(64 * MIB);
    expect(fake.store.get(KEY)?.bytes[64 * MIB - 1]).toBe(64);
  });

  test('a part is 8 MiB until 1,000 of them, then doubles, so 10,000 parts reach past 5 TiB', () => {
    expect(streamPartBytes(1)).toBe(STREAM_PART_BYTES);
    expect(streamPartBytes(1000)).toBe(STREAM_PART_BYTES);
    expect(streamPartBytes(1001)).toBe(2 * STREAM_PART_BYTES);
    let capacity = 0;
    for (let part = 1; part <= 10_000; part += 1) capacity += streamPartBytes(part);
    expect(capacity).toBeGreaterThan(5 * 1024 * 1024 * MIB);
    expect(streamPartBytes(10_000)).toBeLessThanOrEqual(MAX_PART_BYTES);
  });
});

describe('partBytesFor', () => {
  test('never under the protocol floor, and 10,000 parts always cover maxBytes', () => {
    expect(partBytesFor(1)).toBe(5 * MIB);
    expect(partBytesFor(50 * 1024 * MIB)).toBe(Math.ceil((50 * 1024 * MIB) / 10_000));
    const terabyte = 1024 * 1024 * MIB;
    expect(partBytesFor(terabyte) * 10_000).toBeGreaterThanOrEqual(terabyte);
  });
});
