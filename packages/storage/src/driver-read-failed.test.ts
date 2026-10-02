// No public StorageDriver method leaves with a bare throw. The write half is
// `driver-put-failed.test.ts`; this is the read half and the wrong-type arguments every method
// shares — a provider's refusal, an unreadable file, a key or a body that is not what its type says.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive remove and no `mkdir` — none has a `Bun.*`
// equivalent, and the local disk needs a real directory per run.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { isUltimateError } from '@ultimat3/core';
import type { StorageBody, StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { etagOfFile, readObjectBytes } from './driver-local-read';
import { memoryDriver } from './driver-memory';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, FakeS3Client, s3Error } from './driver-s3-fixture';

const codeOf = (caught: unknown): string =>
  isUltimateError(caught) ? caught.code : `not-a-coded-error: ${String(caught)}`;

let root = '';
let fake: FakeS3Client;
let local: StorageDriver;
let memory: StorageDriver;
let s3: StorageDriver;
const KEY = 'org/o1/a.txt';

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-read-failed-`);
  fake = new FakeS3Client();
  local = localDriver({ root, signingSecret: 'test-secret' });
  memory = memoryDriver({ signingSecret: 'test-secret' });
  s3 = s3Driver({ bucket: 'b', client: fake });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a provider refusal on an s3 read', () => {
  test('get, stat, exists, stream and the read half of copy are X_STORAGE_READ_FAILED', async () => {
    await s3.put(KEY, bytesOf('x'));
    fake.failReadWith = s3Error('AccessDenied', 403, KEY);
    const calls: Record<string, () => Promise<unknown>> = {
      get: () => s3.get(KEY),
      stat: () => s3.stat(KEY),
      exists: () => s3.exists(KEY),
      stream: () => s3.stream(KEY),
      copy: () => s3.copy(KEY, 'org/o1/b.txt'),
    };
    for (const [name, call] of Object.entries(calls)) {
      const refused = await catchError(call);
      expect([name, codeOf(refused)]).toEqual([name, 'X_STORAGE_READ_FAILED']);
      expect(isUltimateError(refused) ? refused.cause : '').toContain('AccessDenied');
      expect(isUltimateError(refused) ? refused.fix : '').toBe(
        `aws s3api head-object --bucket b --key ${KEY}`,
      );
    }
    expect(fake.store.has('org/o1/b.txt')).toBe(false);
  });

  test('the stat AFTER a successful write is coded too, on put and on copy', async () => {
    await s3.put(KEY, bytesOf('x'));
    fake.failStatWith = s3Error('SlowDown', 503, KEY);
    expect(codeOf(await catchError(() => s3.put('org/o1/c.txt', bytesOf('y'))))).toBe(
      'X_STORAGE_READ_FAILED',
    );
    // The write itself landed: the refusal is about reading it back, and says so.
    expect(fake.store.has('org/o1/c.txt')).toBe(true);
  });

  test('a provider 404 between exists() and the read is X_STORAGE_NOT_FOUND, never a read failure', async () => {
    await s3.put(KEY, bytesOf('x'));
    fake.failStatWith = s3Error('NoSuchKey', 404, KEY);
    expect(codeOf(await catchError(() => s3.get(KEY)))).toBe('X_STORAGE_NOT_FOUND');
    expect(codeOf(await catchError(() => s3.stat(KEY)))).toBe('X_STORAGE_NOT_FOUND');
  });
});

describe('an unreadable file on the local disk', () => {
  // A directory where the bytes should be is the cheapest read the OS refuses with something
  // other than ENOENT (EISDIR) — no root and no chmod, as the delete tests already do it.
  test('a read the OS refuses is X_STORAGE_READ_FAILED, carrying the runtime’s own reason', async () => {
    await mkdir(`${root}/org/o1/dir`, { recursive: true });
    for (const read of [
      () => readObjectBytes(root, 'org/o1/dir'),
      () => etagOfFile(root, 'org/o1/dir'),
    ]) {
      const refused = await catchError(read);
      expect(codeOf(refused)).toBe('X_STORAGE_READ_FAILED');
      expect(isUltimateError(refused) ? refused.cause : '').toMatch(
        /^disk "local" refused to read "org\/o1\/dir": .+/,
      );
      expect(isUltimateError(refused) ? refused.fix : '').toBe(`ls -l ${root}/org/o1/dir`);
    }
  });

  test('a file that vanished before the read is X_STORAGE_NOT_FOUND', async () => {
    expect(codeOf(await catchError(() => readObjectBytes(root, 'org/o1/gone')))).toBe(
      'X_STORAGE_NOT_FOUND',
    );
    expect(codeOf(await catchError(() => etagOfFile(root, 'org/o1/gone')))).toBe(
      'X_STORAGE_NOT_FOUND',
    );
  });
});

describe('an argument that is not what its type says, on every method of every disk', () => {
  const notAKey = undefined as unknown as string;

  test('a key that is not a string is X_STORAGE_PATH_UNSAFE, never a TypeError', async () => {
    for (const disk of [local, memory, s3]) {
      const calls: Record<string, () => Promise<unknown>> = {
        put: () => disk.put(notAKey, bytesOf('x')),
        get: () => disk.get(notAKey),
        stat: () => disk.stat(notAKey),
        stream: () => disk.stream(notAKey),
        copyFrom: () => disk.copy(notAKey, KEY),
        copyTo: () => disk.copy(KEY, notAKey),
        delete: () => disk.delete(notAKey),
        exists: () => disk.exists(notAKey),
        signedUrl: () => disk.signedUrl(notAKey),
      };
      for (const [name, call] of Object.entries(calls)) {
        expect([disk.name, name, codeOf(await catchError(async () => call()))]).toEqual([
          disk.name,
          name,
          'X_STORAGE_PATH_UNSAFE',
        ]);
      }
    }
  });

  test('a body that is not bytes, a Blob or a stream is X_INVARIANT, and nothing is stored', async () => {
    for (const disk of [local, memory, s3]) {
      for (const body of ['a string', 7, null, undefined, { bytes: 1 }]) {
        const refused = await catchError(() => disk.put(KEY, body as unknown as StorageBody));
        expect([disk.name, codeOf(refused)]).toEqual([disk.name, 'X_INVARIANT']);
      }
      expect(await disk.exists(KEY)).toBe(false);
    }
  });

  test('a list prefix or cursor that is not a string is X_INVARIANT', async () => {
    for (const disk of [local, memory, s3]) {
      for (const options of [{ prefix: 7 }, { cursor: {} }]) {
        const refused = await catchError(() => disk.list(options as never));
        expect([disk.name, codeOf(refused)]).toEqual([disk.name, 'X_INVARIANT']);
      }
    }
  });
});
