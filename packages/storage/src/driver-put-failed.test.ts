// A write the disk refused is a coded refusal on every driver — never the bare filesystem `Error`,
// bare `S3Error` or bare `TypeError` it used to be.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `mkdtemp` and `rm` have no
// `Bun.*` equivalent, and the local disk needs a real directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { isUltimateError } from '@ultimat3/core';
import type { PutOptions, StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { commitObject } from './driver-local-write';
import { memoryStorageDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FakeS3Client, s3Error, textOf } from './driver-s3-fixture';

const anyCodeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let fake: FakeS3Client;
let local: StorageDriver;
let memory: StorageDriver;
let s3: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-put-failed-`);
  fake = new FakeS3Client();
  local = localDriver({ root, signingSecret: 'test-secret' });
  memory = memoryStorageDriver({ signingSecret: 'test-secret' });
  s3 = s3Driver({ bucket: 'b', client: fake });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a filesystem refusal on the local disk', () => {
  test.each(['EACCES', 'ENOSPC', 'EROFS'])(
    '%s from the rename is X_STORAGE_PUT_FAILED, naming the errno',
    async (errno) => {
      const refused = await catchError(() =>
        commitObject(
          {
            root,
            key: 'org/o1/a.txt',
            disk: 'local',
            body: bytesOf('x'),
            sidecar: { contentType: 't/x', etag: 'e' },
          },
          {
            rename: () =>
              Promise.reject(Object.assign(new Error(`${errno}: refused`), { code: errno })),
            unlink: () => Promise.resolve(),
          },
        ),
      );
      expect(anyCodeOf(refused)).toBe('X_STORAGE_PUT_FAILED');
      expect(isUltimateError(refused) ? refused.cause : '').toContain(errno);
      expect(isUltimateError(refused) ? refused.fix : '').toBe(`ls -ld ${root} && df -h ${root}`);
      expect(await local.exists('org/o1/a.txt')).toBe(false);
    },
  );

  test('a staging directory the disk cannot use refuses put() AND copy() by code', async () => {
    // A FILE where `.meta/.tmp/` must be a directory: every staged write is refused by the OS, and
    // the source of the copy was stored before the disk went bad.
    await local.put('org/o1/src.txt', bytesOf('source'));
    await rm(`${root}/.meta/.tmp`, { recursive: true, force: true });
    await Bun.write(`${root}/.meta/.tmp`, 'not a directory');

    for (const write of [
      () => local.put('org/o1/a.txt', bytesOf('x')),
      () => local.copy('org/o1/src.txt', 'org/o1/a.txt'),
    ]) {
      const refused = await catchError(write);
      expect(anyCodeOf(refused)).toBe('X_STORAGE_PUT_FAILED');
      expect(isUltimateError(refused) ? refused.fix : '').toBe(`ls -ld ${root} && df -h ${root}`);
    }
    expect(await local.exists('org/o1/a.txt')).toBe(false);
    expect(textOf((await local.get('org/o1/src.txt')).bytes)).toBe('source');
  });

  test('a root that is a FILE refuses put() by code, through the driver', async () => {
    const file = `${root}/not-a-directory`;
    await Bun.write(file, 'x');
    const onAFile = localDriver({ root: file, signingSecret: 'test-secret' });
    expect(anyCodeOf(await catchError(() => onAFile.put('a.txt', bytesOf('x'))))).toBe(
      'X_STORAGE_PUT_FAILED',
    );
  });
});

describe('a provider refusal on the s3 disk', () => {
  test('a refused write is X_STORAGE_PUT_FAILED on put() and on copy()', async () => {
    await s3.put('org/o1/src.txt', bytesOf('source'));
    fake.failWriteWith = s3Error('AccessDenied', 403, 'org/o1/a.txt');

    const put = await catchError(() => s3.put('org/o1/a.txt', bytesOf('x')));
    expect(anyCodeOf(put)).toBe('X_STORAGE_PUT_FAILED');
    expect(isUltimateError(put) ? put.cause : '').toContain('AccessDenied');
    expect(anyCodeOf(await catchError(() => s3.copy('org/o1/src.txt', 'org/o1/b.txt')))).toBe(
      'X_STORAGE_PUT_FAILED',
    );
    expect(fake.store.has('org/o1/a.txt')).toBe(false);
    expect(fake.store.has('org/o1/b.txt')).toBe(false);
  });
});

describe('put() options that are not what their type says', () => {
  const untyped = (options: Record<string, unknown>): PutOptions => options as PutOptions;

  // A `bigint` in `metadata` reached `JSON.stringify` on the local disk as a bare `TypeError`, and
  // the memory disk stored it — a `Record<string, string>` every reader downstream is typed on.
  test.each([
    ['a bigint value', { metadata: { n: 1n } }],
    ['a number value', { metadata: { n: 1 } }],
    ['an array', { metadata: ['a'] }],
    ['a non-string cacheControl', { cacheControl: 60 }],
    ['a non-string contentType', { contentType: { type: 'image/png' } }],
  ])(
    '%s is refused by the local and the memory disk, and nothing is stored',
    async (_name, options) => {
      for (const disk of [local, memory]) {
        const refused = await catchError(() =>
          disk.put('org/o1/a.txt', bytesOf('x'), untyped(options)),
        );
        expect(anyCodeOf(refused)).toBe('X_INVARIANT');
        expect(await disk.exists('org/o1/a.txt')).toBe(false);
      }
    },
  );

  test('s3 refuses a non-string contentType too, before the provider is asked', async () => {
    const refused = await catchError(() =>
      s3.put('org/o1/a.txt', bytesOf('x'), untyped({ contentType: 7 })),
    );
    expect(anyCodeOf(refused)).toBe('X_INVARIANT');
    expect(fake.store.has('org/o1/a.txt')).toBe(false);
  });

  test('string metadata still round-trips', async () => {
    for (const disk of [local, memory]) {
      await disk.put('org/o1/ok.txt', bytesOf('x'), {
        metadata: { a: 'b' },
        cacheControl: 'no-store',
      });
      const read = await disk.get('org/o1/ok.txt');
      expect([textOf(read.bytes), read.object.metadata, read.object.cacheControl]).toEqual([
        'x',
        { a: 'b' },
        'no-store',
      ]);
    }
  });
});
