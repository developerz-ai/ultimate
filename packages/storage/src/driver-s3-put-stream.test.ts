// What `putStream` puts on the s3 wire: an ordinary signed PUT for a body that fits one part, a
// multipart upload past it, and an AbortMultipartUpload on every way out that is not a complete,
// because the object must not exist until the whole body has been accepted.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, s3Error, textOf } from './driver-s3-fixture';
import { partBytesFor } from './multipart';

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
    // Parts are cut at the first chunk boundary at the floor: at most one part + one chunk resident.
    const parts = fake.signedCalls.filter((call) => call.url.searchParams.has('partNumber'));
    expect(parts.map((call) => call.body?.byteLength)).toEqual([5 * MIB, 5 * MIB, 2 * MIB]);
  });

  test('a body ending exactly on a part sends no empty last part', async () => {
    await disk.putStream(KEY, chunksOf(5, MIB), { maxBytes: 64 * MIB });
    expect(callsOf()).toEqual(['POST uploads', 'PUT partNumber,uploadId', 'POST uploadId']);
    expect(fake.store.get(KEY)?.bytes.byteLength).toBe(5 * MIB);
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
      disk.putStream(KEY, chunksOf(6, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
    expect((refused as { cause: string }).cause).toContain('InternalError');
    expect(fake.store.has(KEY)).toBe(false);
    expect(fake.openUploads()).toEqual([]);
  });

  test('a refused create opens nothing to abort', async () => {
    fake.failCreateWith = s3Error('AccessDenied', 403, KEY);
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(6, MIB), { maxBytes: 64 * MIB }),
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
      disk.putStream(KEY, chunksOf(6, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(noId)).toBe('X_STORAGE_PUT_FAILED');
    expect((noId as { cause: string }).cause).toContain('CreateMultipartUpload');

    fake.createAnswersNoId = false;
    fake.partAnswersNoEtag = true;
    const noEtag = await catchError(() =>
      disk.putStream(KEY, chunksOf(6, MIB), { maxBytes: 64 * MIB }),
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

describe('partBytesFor', () => {
  test('never under the protocol floor, and 10,000 parts always cover maxBytes', () => {
    expect(partBytesFor(1)).toBe(5 * MIB);
    expect(partBytesFor(50 * 1024 * MIB)).toBe(Math.ceil((50 * 1024 * MIB) / 10_000));
    const terabyte = 1024 * 1024 * MIB;
    expect(partBytesFor(terabyte) * 10_000).toBeGreaterThanOrEqual(terabyte);
  });
});
