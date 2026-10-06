// Single responsibility: everything the s3 driver's `put()` REFUSES — the byte ceiling that keeps
// a buffered write from being an OOM kill, per-object encryption Bun cannot express, and a
// checksum the bytes contradict. Split from `driver-s3.test.ts`, which owns the paths that
// succeed; both drive one fake client. Metadata, cache-control and Object Lock are SENT, over the
// signed wire — `driver-s3-lock.test.ts`.

import { describe, expect, test } from 'bun:test';
import { sha256Base64 } from './driver';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, FAKE_ENV, FakeS3Client } from './driver-s3-fixture';
import type { StorageError } from './errors';
import { DEFAULT_MAX_UPLOAD_BYTES } from './upload';

describe('s3Driver put', () => {
  describe('put: the byte ceiling', () => {
    test('a body over maxPutBytes is refused BEFORE anything is written', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, maxPutBytes: 8 });

      const caught = await catchError(() => driver.put('org/org-1/big.bin', bytesOf('123456789')));
      expect(codeOf(caught)).toBe('X_STORAGE_TOO_LARGE');
      const error = caught as StorageError;
      expect(error.fix).toContain('grantUpload');
      expect(error.fix).toContain('s3Driver({ bucket, maxPutBytes: 9 })');
      expect(fake.store.has('org/org-1/big.bin')).toBe(false);
    });

    test('a STREAM is cut off at the ceiling rather than buffered whole', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, maxPutBytes: 4 });
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          // Unbounded on purpose: the reader must stop, not the producer. Before the ceiling
          // existed this loop was the OOM — every chunk landed in the heap.
          controller.enqueue(bytesOf('xxx'));
        },
      });

      const caught = await catchError(() => driver.put('org/org-1/stream.bin', body));
      expect(codeOf(caught)).toBe('X_STORAGE_TOO_LARGE');
      // Two 3-byte chunks crossed 4; a buffering reader would have run forever.
      expect(pulled).toBe(2);
      expect(fake.store.has('org/org-1/stream.bin')).toBe(false);
    });

    test('the default ceiling is the upload policy ceiling', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/huge.bin', new Uint8Array(DEFAULT_MAX_UPLOAD_BYTES + 1)),
      );
      expect(codeOf(caught)).toBe('X_STORAGE_TOO_LARGE');
    });
  });

  describe('put: server-side encryption is refused, visibly', () => {
    test('a kms request throws X_NOT_IMPLEMENTED naming the bucket-wide command', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/s.txt', bytesOf('x'), {
          serverSideEncryption: { algorithm: 'aws:kms', kmsKeyId: 'arn:aws:kms:::key/abc' },
        }),
      );
      expect(caught).toBeUltimateError('X_NOT_IMPLEMENTED');
      const error = caught as StorageError;
      // The fix opens with the command itself: the explanation is the cause's, never the fix's.
      expect(error.fix).toStartWith('aws s3api put-bucket-encryption --bucket b ');
      expect(error.fix).toContain('arn:aws:kms:::key/abc');
      expect(error.cause).toContain('drop serverSideEncryption from put()');
      expect(fake.store.has('org/org-1/s.txt')).toBe(false);
    });

    test('AES256 asks for no key id', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/t.txt', bytesOf('x'), {
          serverSideEncryption: { algorithm: 'AES256' },
        }),
      );
      const error = caught as StorageError;
      expect(error.fix).toContain('{"SSEAlgorithm":"AES256"}');
      expect(error.fix).not.toContain('KMSMasterKeyID');
    });
  });

  describe('put: checksum', () => {
    test('a correct checksum passes', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const bytes = bytesOf('checksum-me');
      const checksum = sha256Base64(bytes);

      const put = await driver.put('org/org-1/d.txt', bytes, { checksum });
      expect(put.size).toBe(bytes.byteLength);
    });

    test('a mismatched checksum throws checksumMismatch (X_STORAGE_CHECKSUM_MISMATCH)', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/e.txt', bytesOf('checksum-me'), { checksum: 'not-the-hash' }),
      );
      expect(codeOf(caught)).toBe('X_STORAGE_CHECKSUM_MISMATCH');
      // The write must never have happened.
      expect(fake.store.has('org/org-1/e.txt')).toBe(false);
    });
  });

  describe('put: metadata / cacheControl are no longer refused', () => {
    // They were `X_NOT_IMPLEMENTED` while `Bun.S3Client` was the only transport; core's
    // `signAwsRequest` lets the driver send the headers itself.
    test('metadata and cacheControl travel on one signed PUT, not on the Bun client', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
      await driver.put('org/org-1/f.txt', bytesOf('x'), {
        metadata: { owner: 'a' },
        cacheControl: 'no-cache',
      });
      expect(fake.signedCalls).toHaveLength(1);
      expect(fake.headersOf.get('org/org-1/f.txt')).toMatchObject({
        'x-amz-meta-owner': 'a',
        'cache-control': 'no-cache',
      });
    });
  });
});
