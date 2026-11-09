// The last request of a `putStream` sent and its answer lost. The provider may have stored the
// object, so "never happened" is a claim the driver has to earn: it stats the key against what was
// sent, and aborts only to learn whether the upload is still open. What cannot be settled is said.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FAKE_ENV, FakeS3Client, s3Error, textOf } from './driver-s3-fixture';

const KEY = 'org/org-1/film.mp4';
const MIB = 1024 * 1024;
const anyCode = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

const chunksOf = (count: number, bytes: number): ReadableStream<Uint8Array> => {
  let left = count;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) return controller.close();
      left -= 1;
      controller.enqueue(new Uint8Array(bytes).fill(count - left));
    },
  });
};

let fake: FakeS3Client;
let disk: StorageDriver;

beforeEach(() => {
  fake = new FakeS3Client();
  disk = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
});

describe('a multipart Complete whose answer never arrives', () => {
  test('landed: the object it stored is reported, never X_STORAGE_PUT_FAILED', async () => {
    fake.loseAnswerOf = 'complete-after';
    const object = await disk.putStream(KEY, chunksOf(12, MIB), { maxBytes: 64 * MIB });
    expect(object.size).toBe(12 * MIB);
    expect(fake.store.get(KEY)?.bytes.byteLength).toBe(12 * MIB);
    // Settled by the stat: no abort was needed to learn it.
    expect(fake.signedCalls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  test('never reached the provider: aborted, a refused write, and the key as it was', async () => {
    await disk.put(KEY, bytesOf('previous'));
    fake.loseAnswerOf = 'complete-before';
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(12, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
    // The lost request's own failure, not one the recovery raised on the way.
    expect((refused as { cause: string }).cause).toContain('socket connection was closed');
    expect(fake.openUploads()).toEqual([]);
    expect(textOf(fake.store.get(KEY)?.bytes ?? new Uint8Array())).toBe('previous');
  });

  test('landed, then overwritten before the stat: the upload is gone and nothing proves which', async () => {
    fake.loseAnswerOf = 'complete-after';
    fake.afterLostAnswer = () => fake.store.set(KEY, { bytes: bytesOf('someone else') });
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(12, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
    expect((refused as { fix: string }).fix).toContain('stat(');
  });

  test('an abort whose answer is lost too cannot settle it, and is not reported as a refusal', async () => {
    fake.loseAnswerOf = 'complete-after';
    fake.afterLostAnswer = () => {
      fake.store.set(KEY, { bytes: bytesOf('someone else') });
      fake.loseAnswerOf = 'abort-before';
    };
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(12, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
  });

  test('a stat that is itself refused cannot settle it either', async () => {
    fake.loseAnswerOf = 'complete-after';
    fake.afterLostAnswer = () => {
      fake.failStatWith = s3Error('SlowDown', 503, KEY);
    };
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(12, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
  });

  test('a Complete the provider REFUSED is still the plain refusal: it answered', async () => {
    fake.failCompleteWith = s3Error('InternalError', 200, KEY);
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(10, MIB), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_PUT_FAILED');
  });
});

describe('a single-part PUT whose answer never arrives', () => {
  test('landed: reported as stored', async () => {
    fake.loseAnswerOf = 'put-after';
    const object = await disk.putStream(KEY, chunksOf(2, 1024), { maxBytes: 64 * MIB });
    expect(object.size).toBe(2048);
  });

  test('not landed: a PUT cannot be aborted, so the outcome is said to be unknown', async () => {
    fake.loseAnswerOf = 'put-before';
    const refused = await catchError(() =>
      disk.putStream(KEY, chunksOf(2, 1024), { maxBytes: 64 * MIB }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
    expect(fake.store.has(KEY)).toBe(false);
  });
});

describe('a plain put() whose answer never arrives', () => {
  test('landed through the Bun client: reported as stored, never X_STORAGE_PUT_FAILED', async () => {
    fake.loseAnswerOf = 'write-after';
    const object = await disk.put(KEY, bytesOf('hello'));
    expect(object.size).toBe(5);
  });

  test('not landed: the outcome is said to be unknown, on both transports', async () => {
    fake.loseAnswerOf = 'write-before';
    expect(anyCode(await catchError(() => disk.put(KEY, bytesOf('hello'))))).toBe(
      'X_STORAGE_WRITE_OUTCOME_UNKNOWN',
    );
    fake.loseAnswerOf = 'put-before';
    const signed = await catchError(() =>
      disk.put(KEY, bytesOf('hello'), { metadata: { a: 'b' } }),
    );
    expect(anyCode(signed)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
  });

  // The same bytes again: size and etag match the PREVIOUS object, so they prove nothing about a
  // write that also changed what the object says about itself.
  test('an overwrite of the same bytes with another type is judged on the type too', async () => {
    await disk.put(KEY, bytesOf('hello'), { contentType: 'text/plain' });
    fake.loseAnswerOf = 'write-before';
    const refused = await catchError(() =>
      disk.put(KEY, bytesOf('hello'), { contentType: 'text/html' }),
    );
    expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
  });

  test('what a HEAD cannot read back leaves it unknown, never success', async () => {
    for (const options of [
      { metadata: { run: 'r-2' } },
      { cacheControl: 'no-store' },
      { legalHold: true },
    ]) {
      fake.loseAnswerOf = 'put-after';
      const refused = await catchError(() => disk.put(KEY, bytesOf('hello'), options));
      expect(anyCode(refused)).toBe('X_STORAGE_WRITE_OUTCOME_UNKNOWN');
    }
  });

  test('the same type, landed, is still reported as stored', async () => {
    fake.loseAnswerOf = 'write-after';
    expect((await disk.put(KEY, bytesOf('hello'), { contentType: 'text/plain' })).size).toBe(5);
  });

  test('a write the provider refused is still the refusal: it answered', async () => {
    fake.failWriteWith = s3Error('AccessDenied', 403, KEY);
    expect(anyCode(await catchError(() => disk.put(KEY, bytesOf('hello'))))).toBe(
      'X_STORAGE_PUT_FAILED',
    );
  });
});
