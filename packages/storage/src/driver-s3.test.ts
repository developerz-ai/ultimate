// Single responsibility: pins the s3 driver's request/response contract against an injected
// fake `S3ClientLike` — key guard, stat mapping, list paging, presign options, lazy client.
// WHY a fake and not a bucket: the driver's only job is translating Bun's S3 surface into
// StorageObject/StorageError, so that translation must break here, offline, not in CI or prod.

import { describe, expect, test } from 'bun:test';
import { ConfigInvalidError, EnvMissingError, InternalError } from '@ultimat3/core';
import { sha256Base64 } from './driver';
import {
  type S3ClientLike,
  type S3FileLike,
  type S3ListEntryLike,
  type S3ListResultLike,
  type S3StatLike,
  s3Driver,
} from './driver-s3';
import { isStorageError, objectNotFound } from './errors';

/** The driver's private `DRIVER_NAME`; the fake reports failures against the same disk. */
const FAKE_DISK = 's3';

interface FakeObject {
  bytes: Uint8Array;
  type?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | Date | undefined;
}

interface PresignCall {
  key: string;
  options: {
    method?: string | undefined;
    expiresIn?: number | undefined;
    type?: string | undefined;
  };
}

interface ListCall {
  prefix?: string | undefined;
  maxKeys?: number | undefined;
  continuationToken?: string | undefined;
}

/** In-memory stand-in for `Bun.S3Client`, driven through `S3ClientLike` — no socket, ever. */
class FakeS3Client implements S3ClientLike {
  readonly store = new Map<string, FakeObject>();
  readonly fileCalls: string[] = [];
  readonly presignCalls: PresignCall[] = [];
  readonly listCalls: ListCall[] = [];
  listResult: S3ListResultLike = { contents: [] };
  failDeleteFor: string | undefined;

  file(key: string): S3FileLike {
    this.fileCalls.push(key);
    const store = this.store;
    const client = this;
    return {
      async write(data, options) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
        store.set(key, { bytes, type: options?.type });
        return bytes.byteLength;
      },
      async arrayBuffer() {
        const entry = store.get(key);
        // Reads the way the provider does: a GET on a key that is not there is a 404, and the
        // driver is expected to have gated it behind exists() before ever getting here.
        if (entry === undefined) throw objectNotFound(FAKE_DISK, key);
        return new Uint8Array(entry.bytes).buffer;
      },
      async exists() {
        return store.has(key);
      },
      async delete() {
        // Deliberately NOT a StorageError: the driver's catch-all has to swallow a rejection
        // it never authored, which is the only kind a real provider hands back.
        if (client.failDeleteFor === key) {
          throw new InternalError({
            cause: `the fake s3 provider rejected DELETE ${key}`,
            fix: 'clear failDeleteFor on the fake client to let the delete through',
          });
        }
        store.delete(key);
      },
      stream() {
        const entry = store.get(key);
        const bytes = entry?.bytes ?? new Uint8Array();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      },
      async stat(): Promise<S3StatLike> {
        const entry = store.get(key);
        if (entry === undefined) throw objectNotFound(FAKE_DISK, key);
        return {
          size: entry.bytes.byteLength,
          type: entry.type,
          etag: entry.etag,
          lastModified: entry.lastModified,
        };
      },
      presign(options) {
        client.presignCalls.push({ key, options });
        return `https://fake.example/${key}?signed`;
      },
    };
  }

  async list(input: ListCall): Promise<S3ListResultLike> {
    this.listCalls.push(input);
    return this.listResult;
  }
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function codeOf(caught: unknown): string {
  return isStorageError(caught) ? caught.code : `not-a-storage-error: ${String(caught)}`;
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('s3Driver', () => {
  describe('put / get / exists / delete / stream', () => {
    test('round-trips through the fake client, mapping stat() into StorageObject', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });

      const put = await driver.put('org/org-1/a.txt', bytesOf('hello'), {
        contentType: 'text/plain',
      });
      expect(put.key).toBe('org/org-1/a.txt');
      expect(put.size).toBe(5);
      expect(put.contentType).toBe('text/plain');

      // Simulate the provider assigning an etag and a lastModified after the write.
      const entry = fake.store.get('org/org-1/a.txt');
      if (entry !== undefined) {
        entry.etag = 'provider-etag';
        entry.lastModified = '2026-01-02T03:04:05.000Z';
      }

      expect(await driver.exists('org/org-1/a.txt')).toBe(true);

      const read = await driver.get('org/org-1/a.txt');
      expect(textOf(read.bytes)).toBe('hello');
      expect(read.object.etag).toBe('provider-etag');
      expect(read.object.lastModified).toEqual(new Date('2026-01-02T03:04:05.000Z'));

      const stream = await driver.stream('org/org-1/a.txt');
      expect(await new Response(stream).text()).toBe('hello');

      await driver.delete('org/org-1/a.txt');
      expect(await driver.exists('org/org-1/a.txt')).toBe(false);
    });

    test('falls back to DEFAULT_CONTENT_TYPE and empty etag when stat() omits them', async () => {
      const fake = new FakeS3Client();
      fake.store.set('org/org-1/b.bin', { bytes: bytesOf('x') });
      const driver = s3Driver({ bucket: 'b', client: fake });

      const read = await driver.get('org/org-1/b.bin');
      expect(read.object.contentType).toBe('application/octet-stream');
      expect(read.object.etag).toBe('');
      // stat() gave no lastModified either, so it reads as the epoch.
      expect(read.object.lastModified).toEqual(new Date(0));
    });

    test('get on a missing key throws objectNotFound (X_STORAGE_NOT_FOUND)', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() => driver.get('org/org-1/missing.txt'));
      expect(codeOf(caught)).toBe('X_STORAGE_NOT_FOUND');
    });

    test('stream on a missing key throws objectNotFound (X_STORAGE_NOT_FOUND)', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() => driver.stream('org/org-1/missing.txt'));
      expect(codeOf(caught)).toBe('X_STORAGE_NOT_FOUND');
    });

    test('delete swallows a rejecting file().delete()', async () => {
      const fake = new FakeS3Client();
      fake.store.set('org/org-1/c.txt', { bytes: bytesOf('c') });
      fake.failDeleteFor = 'org/org-1/c.txt';
      const driver = s3Driver({ bucket: 'b', client: fake });

      // Must not throw even though the fake's delete() rejects.
      await driver.delete('org/org-1/c.txt');
      // The rejection was swallowed before removing the entry, so it is still present —
      // proof the promise really did reject rather than resolving silently.
      expect(fake.store.has('org/org-1/c.txt')).toBe(true);
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

  describe('put: metadata / cacheControl not implemented', () => {
    test('metadata throws storageNotImplemented (X_NOT_IMPLEMENTED)', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/f.txt', bytesOf('x'), { metadata: { owner: 'a' } }),
      );
      expect(codeOf(caught)).toBe('X_NOT_IMPLEMENTED');
    });

    test('cacheControl throws storageNotImplemented (X_NOT_IMPLEMENTED)', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() =>
        driver.put('org/org-1/g.txt', bytesOf('x'), { cacheControl: 'no-cache' }),
      );
      expect(codeOf(caught)).toBe('X_NOT_IMPLEMENTED');
    });
  });

  describe('assertSafeKey guard', () => {
    test('an unsafe key never reaches the fake client', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const unsafe = '../escape';

      const putError = await catchError(() => driver.put(unsafe, bytesOf('x')));
      const getError = await catchError(() => driver.get(unsafe));
      const deleteError = await catchError(() => driver.delete(unsafe));
      const existsError = await catchError(() => driver.exists(unsafe));
      const streamError = await catchError(() => driver.stream(unsafe));
      const signedUrlError = await catchError(() => driver.signedUrl(unsafe));

      for (const caught of [
        putError,
        getError,
        deleteError,
        existsError,
        streamError,
        signedUrlError,
      ]) {
        expect(codeOf(caught)).toBe('X_STORAGE_PATH_UNSAFE');
      }
      // The guard fires before any of these methods ever call `client.file()`.
      expect(fake.fileCalls).toEqual([]);
    });
  });

  describe('list', () => {
    test('maps entries and skips ones with an undefined key', async () => {
      const fake = new FakeS3Client();
      const entries: S3ListEntryLike[] = [
        {
          key: 'org/org-1/a.txt',
          size: 3,
          eTag: 'etag-a',
          lastModified: '2026-01-01T00:00:00.000Z',
        },
        { key: undefined, size: 9 },
        { key: 'org/org-1/b.txt' },
      ];
      fake.listResult = { contents: entries, isTruncated: false };
      const driver = s3Driver({ bucket: 'b', client: fake });

      const page = await driver.list({ prefix: 'org/org-1/' });
      expect(page.objects).toEqual([
        {
          key: 'org/org-1/a.txt',
          size: 3,
          contentType: 'application/octet-stream',
          etag: 'etag-a',
          lastModified: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          key: 'org/org-1/b.txt',
          size: 0,
          contentType: 'application/octet-stream',
          etag: '',
          lastModified: new Date(0),
        },
      ]);
    });

    test('uses DEFAULT_LIST_LIMIT when no limit is given, and forwards prefix/cursor', async () => {
      const fake = new FakeS3Client();
      fake.listResult = { contents: [] };
      const driver = s3Driver({ bucket: 'b', client: fake });

      await driver.list({ prefix: 'org/org-1/', cursor: 'page-2-token' });
      expect(fake.listCalls).toEqual([
        { prefix: 'org/org-1/', maxKeys: 1000, continuationToken: 'page-2-token' },
      ]);

      await driver.list({ prefix: 'org/org-1/', limit: 25 });
      expect(fake.listCalls[1]).toEqual({ prefix: 'org/org-1/', maxKeys: 25 });
    });

    test('truncated: true with a cursor only when isTruncated is true AND a token is present', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });

      fake.listResult = { contents: [], isTruncated: true, nextContinuationToken: 'next-token' };
      const truncated = await driver.list();
      expect(truncated).toEqual({ objects: [], truncated: true, cursor: 'next-token' });

      // isTruncated is true but there is no token — the `&&` means this reads as NOT truncated.
      fake.listResult = { contents: [], isTruncated: true };
      const noToken = await driver.list();
      expect(noToken).toEqual({ objects: [], truncated: false });

      fake.listResult = { contents: [], isTruncated: false, nextContinuationToken: 'stale-token' };
      const notTruncated = await driver.list();
      expect(notTruncated).toEqual({ objects: [], truncated: false });
    });
  });

  describe('signedUrl', () => {
    test('defaults: expiresInMs 900_000 -> expiresIn 900, method GET, no contentType', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });

      await driver.signedUrl('org/org-1/h.txt');
      expect(fake.presignCalls).toEqual([
        { key: 'org/org-1/h.txt', options: { method: 'GET', expiresIn: 900 } },
      ]);
    });

    test('rounds expiresIn up (Math.ceil) and passes method/contentType through', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });

      await driver.signedUrl('org/org-1/i.txt', {
        method: 'PUT',
        expiresInMs: 1_500,
        contentType: 'image/png',
      });
      expect(fake.presignCalls).toEqual([
        { key: 'org/org-1/i.txt', options: { method: 'PUT', expiresIn: 2, type: 'image/png' } },
      ]);
    });
  });

  describe('toDate via stat() and list entries', () => {
    test('undefined lastModified reads as the epoch', async () => {
      const fake = new FakeS3Client();
      fake.store.set('org/org-1/j.txt', { bytes: bytesOf('x'), lastModified: undefined });
      const driver = s3Driver({ bucket: 'b', client: fake });
      const read = await driver.get('org/org-1/j.txt');
      expect(read.object.lastModified).toEqual(new Date(0));
    });

    test('a Date instance passes through unchanged', async () => {
      const fake = new FakeS3Client();
      const date = new Date('2026-05-05T05:05:05.000Z');
      fake.store.set('org/org-1/k.txt', { bytes: bytesOf('x'), lastModified: date });
      const driver = s3Driver({ bucket: 'b', client: fake });
      const read = await driver.get('org/org-1/k.txt');
      expect(read.object.lastModified).toBe(date);
    });

    test('a string is parsed into a Date', async () => {
      const fake = new FakeS3Client();
      fake.store.set('org/org-1/l.txt', {
        bytes: bytesOf('x'),
        lastModified: '2026-06-06T06:06:06.000Z',
      });
      const driver = s3Driver({ bucket: 'b', client: fake });
      const read = await driver.get('org/org-1/l.txt');
      expect(read.object.lastModified).toEqual(new Date('2026-06-06T06:06:06.000Z'));
    });
  });

  describe('buildClient: credential and config wiring', () => {
    test('a missing S3_ACCESS_KEY_ID env var throws EnvMissingError naming it', async () => {
      const driver = s3Driver({ bucket: 'b', env: {} });
      const caught = await catchError(() => driver.exists('org/org-1/a.txt'));
      expect(caught).toBeInstanceOf(EnvMissingError);
      const error = caught as EnvMissingError;
      expect(error.code).toBe('X_ENV_MISSING');
      expect(error.meta).toEqual({ missing: 'S3_ACCESS_KEY_ID' });
    });

    test('a missing secret env var throws EnvMissingError naming it, once the key id is set', async () => {
      const driver = s3Driver({ bucket: 'b', env: { S3_ACCESS_KEY_ID: 'id' } });
      const caught = await catchError(() => driver.exists('org/org-1/a.txt'));
      expect(caught).toBeInstanceOf(EnvMissingError);
      const error = caught as EnvMissingError;
      expect(error.meta).toEqual({ missing: 'S3_SECRET_ACCESS_KEY' });
    });

    test('an empty bucket throws ConfigInvalidError, even before env is checked', async () => {
      const driver = s3Driver({ bucket: '', env: {} });
      const caught = await catchError(() => driver.exists('org/org-1/a.txt'));
      expect(caught).toBeInstanceOf(ConfigInvalidError);
      const error = caught as ConfigInvalidError;
      expect(error.code).toBe('X_CONFIG_INVALID');
    });
  });
});
