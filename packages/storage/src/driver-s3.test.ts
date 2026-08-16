// Single responsibility: pins the s3 driver's request/response contract against an injected
// fake `S3ClientLike` — key guard, stat mapping, copy, list paging, presign options, lazy client.
// WHY a fake and not a bucket: the driver's only job is translating Bun's S3 surface into
// StorageObject/StorageError, so that translation must break here, offline, not in CI or prod.
// What `put()` refuses lives in `driver-s3-put.test.ts`; the fake both drive is the fixture.

import { describe, expect, test } from 'bun:test';
import { ConfigInvalidError, EnvMissingError } from '@ultimat3/core';
import { type S3ListEntryLike, s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, FakeS3Client, textOf } from './driver-s3-fixture';
import type { StorageError } from './errors';
import { META_DIR, scopedKey } from './path';

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

    test('delete SURFACES a refused delete as X_STORAGE_DELETE_FAILED', async () => {
      // The failure that matters, and the one that shipped wrong: `.catch(() => undefined)` made
      // a denied `s3:DeleteObject` indistinguishable from a completed one, so an erasure sweep
      // reported 200 objects deleted that were all still in the bucket.
      const fake = new FakeS3Client();
      fake.store.set('org/org-1/c.txt', { bytes: bytesOf('c') });
      fake.failDeleteFor = 'org/org-1/c.txt';
      const driver = s3Driver({ bucket: 'b', client: fake });

      const caught = await catchError(() => driver.delete('org/org-1/c.txt'));
      expect(codeOf(caught)).toBe('X_STORAGE_DELETE_FAILED');
      const error = caught as StorageError;
      // The provider's own words reach the cause, and the fix names an executable command.
      expect(error.cause).toContain('AccessDenied');
      expect(error.fix).toContain('s3:DeleteObject');
      expect(error.fix).toContain('aws s3api delete-object --bucket b --key org/org-1/c.txt');
      // Still there: the refusal was real, and the driver did not pretend otherwise.
      expect(fake.store.has('org/org-1/c.txt')).toBe(true);
    });

    test('delete stays idempotent for the ABSENT key, and only that one', async () => {
      const fake = new FakeS3Client();
      fake.absentDeleteFor = 'org/org-1/gone.txt';
      const driver = s3Driver({ bucket: 'b', client: fake });
      // A provider that answers NoSuchKey/404 is reporting the desired state, not a failure.
      await driver.delete('org/org-1/gone.txt');
    });
  });

  describe('copy', () => {
    test('moves bytes without reading them into this process, and keeps the content type', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      await driver.put('org/org-1/from.png', bytesOf('pixels'), { contentType: 'image/png' });

      const copied = await driver.copy('org/org-1/from.png', 'org/org-1/to.png');
      expect(copied.key).toBe('org/org-1/to.png');
      expect(copied.contentType).toBe('image/png');
      expect(textOf(fake.store.get('org/org-1/to.png')?.bytes ?? new Uint8Array())).toBe('pixels');
      // Non-destructive: a move is copy + delete, and the caller owns the second half.
      expect(fake.store.has('org/org-1/from.png')).toBe(true);
    });

    test('copy of a missing source is X_STORAGE_NOT_FOUND, and writes nothing', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const caught = await catchError(() => driver.copy('org/org-1/nope.png', 'org/org-1/to.png'));
      expect(codeOf(caught)).toBe('X_STORAGE_NOT_FOUND');
      expect(fake.store.has('org/org-1/to.png')).toBe(false);
    });

    test('both arguments go through assertSafeKey', async () => {
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      expect(codeOf(await catchError(() => driver.copy('../x', 'org/org-1/to.png')))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
      expect(codeOf(await catchError(() => driver.copy('org/org-1/from.png', '../x')))).toBe(
        'X_STORAGE_PATH_UNSAFE',
      );
      expect(fake.fileCalls).toEqual([]);
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

    test('the reserved .meta first segment is refused here too, though S3 keeps no sidecar', async () => {
      // The reservation belongs to `assertSafeKey`, not to the local driver: a key valid on S3
      // and refused on disk is two key rules, and an app that migrates disks would discover the
      // difference through objects it can no longer write.
      const fake = new FakeS3Client();
      const driver = s3Driver({ bucket: 'b', client: fake });
      const reserved = `${META_DIR}/org/org-1/a.png.json`;

      for (const caught of [
        await catchError(() => driver.put(reserved, bytesOf('x'))),
        await catchError(() => driver.get(reserved)),
        await catchError(() => driver.delete(reserved)),
        await catchError(() => driver.exists(reserved)),
        await catchError(() => driver.stream(reserved)),
        await catchError(() => driver.signedUrl(reserved)),
      ]) {
        expect(codeOf(caught)).toBe('X_STORAGE_PATH_UNSAFE');
      }
      expect(fake.fileCalls).toEqual([]);

      // Only the first segment is reserved — `.meta` deeper in a key is an ordinary name.
      await driver.put(scopedKey('org-1', META_DIR, 'a.json'), bytesOf('ordinary'));
      expect([...new Set(fake.fileCalls)]).toEqual(['org/org-1/.meta/a.json']);
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
      // No `contentType` at all. ListObjectsV2 does not return one, and the driver used to fill
      // in `application/octet-stream` — indistinguishable from an object that really is one,
      // while the local driver reported the truth. Absent is the honest answer.
      expect(page.objects).toEqual([
        {
          key: 'org/org-1/a.txt',
          size: 3,
          etag: 'etag-a',
          lastModified: new Date('2026-01-01T00:00:00.000Z'),
        },
        {
          key: 'org/org-1/b.txt',
          size: 0,
          etag: '',
          lastModified: new Date(0),
        },
      ]);
      expect(page.objects[0]?.contentType).toBeUndefined();
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
