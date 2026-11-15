// Single responsibility: what the s3 driver's `put()` refuses or sends beyond the Bun client — the
// byte ceiling that keeps a buffered write from being an OOM kill, per-object encryption sent on
// the signed wire, and a checksum the bytes contradict. Split from `driver-s3.test.ts`, which owns
// the plain paths; both drive one fake client. Metadata, cache-control and Object Lock are SENT,
// over the signed wire — `driver-s3-lock.test.ts`.

import { describe, expect, test } from 'bun:test';
import { type PutOptions, sha256Base64 } from './driver';
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

  describe('put: server-side encryption travels on the signed PUT', () => {
    const signedHeaders = (fake: FakeS3Client): string =>
      /SignedHeaders=([^,]+)/.exec(fake.signedCalls.at(-1)?.headers['authorization'] ?? '')?.[1] ??
      '';

    test('AES256 is sent as x-amz-server-side-encryption, signed, with no key id', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
      await driver.put('org/org-1/t.txt', bytesOf('x'), {
        serverSideEncryption: { algorithm: 'AES256' },
      });
      expect(fake.signedCalls).toHaveLength(1);
      const headers = fake.headersOf.get('org/org-1/t.txt') ?? {};
      expect(headers['x-amz-server-side-encryption']).toBe('AES256');
      expect(headers['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
      expect(signedHeaders(fake).split(';')).toContain('x-amz-server-side-encryption');
      expect(fake.store.has('org/org-1/t.txt')).toBe(true);
    });

    test('aws:kms carries the caller key id beside the algorithm', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
      await driver.put('org/org-1/s.txt', bytesOf('x'), {
        serverSideEncryption: { algorithm: 'aws:kms', kmsKeyId: 'arn:aws:kms:::key/abc' },
      });
      expect(fake.headersOf.get('org/org-1/s.txt')).toMatchObject({
        'x-amz-server-side-encryption': 'aws:kms',
        'x-amz-server-side-encryption-aws-kms-key-id': 'arn:aws:kms:::key/abc',
      });
      expect(signedHeaders(fake).split(';')).toContain(
        'x-amz-server-side-encryption-aws-kms-key-id',
      );
    });

    test('aws:kms without a key id leaves the key to the bucket default', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
      await driver.put('org/org-1/k.txt', bytesOf('x'), {
        serverSideEncryption: { algorithm: 'aws:kms' },
      });
      const headers = fake.headersOf.get('org/org-1/k.txt') ?? {};
      expect(headers['x-amz-server-side-encryption']).toBe('aws:kms');
      expect(headers['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
    });

    test('what the provider would refuse is refused first, before a byte moves', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake, fetch: fake.fetch, env: FAKE_ENV });
      for (const serverSideEncryption of [
        { algorithm: 'AES256', kmsKeyId: 'arn:aws:kms:::key/abc' },
        { algorithm: 'aws:kms', kmsKeyId: 'arn\nx-injected: 1' },
        { algorithm: 'aws:kms', kmsKeyId: '' },
        { algorithm: 'DES' },
      ]) {
        const caught = await catchError(() =>
          driver.put('org/org-1/r.txt', bytesOf('x'), {
            serverSideEncryption,
          } as unknown as PutOptions),
        );
        expect(caught).toBeUltimateError('X_INVARIANT');
        expect((caught as StorageError).fix).toContain('serverSideEncryption');
      }
      expect(fake.signedCalls).toHaveLength(0);
      expect(fake.store.has('org/org-1/r.txt')).toBe(false);
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
