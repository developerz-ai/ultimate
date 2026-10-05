// T12's twin on the local disk: `X_STORAGE_NOT_FOUND`'s fix is `disk('<name>').list(...)`, so the
// name in it is the one `defineStorage` registered — never `local`, which is
// `X_STORAGE_DISK_UNKNOWN` on any app that called its disk something else.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove; the local disk needs a real
// directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask where temp lives.
import { tmpdir } from 'node:os';
import type { StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { etagOfFile, readObjectBytes } from './driver-local-read';
import { memoryDriver } from './driver-memory';
import { catchError, codeOf } from './driver-s3-fixture';
import { isStorageError } from './errors';
import { defineStorage, resetStorage } from './storage';

const MISSING = 'org/org-1/missing.txt';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-disk-name-`);
});

afterEach(async () => {
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

const uploads = (): StorageDriver => {
  const driver = localDriver({ root, signingSecret: 'test-secret' });
  defineStorage({ disks: { uploads: driver } });
  return driver;
};

const namesUploads = (caught: unknown): void => {
  expect(codeOf(caught)).toBe('X_STORAGE_NOT_FOUND');
  if (!isStorageError(caught)) {
    expect.unreachable('a coded storage error');
    return;
  }
  expect(caught.fix).toContain("disk('uploads').list(");
  expect(caught.fix).not.toContain("disk('local')");
  expect(caught.meta).toMatchObject({ disk: 'uploads' });
};

describe('a local not-found fix names the registered disk', () => {
  test('get, stream and copy of a missing key', async () => {
    const driver = uploads();
    namesUploads(await catchError(() => driver.get(MISSING)));
    namesUploads(await catchError(() => driver.stream(MISSING)));
    namesUploads(await catchError(() => driver.copy(MISSING, 'org/org-1/to.txt')));
  });

  test('a file that vanished before the read names the disk it was read for', async () => {
    namesUploads(await catchError(() => readObjectBytes(root, MISSING, 'uploads')));
    namesUploads(await catchError(() => etagOfFile(root, MISSING, 'uploads')));
  });

  test('a driver no registry named still answers, under its kind', async () => {
    const driver = localDriver({ root, signingSecret: 'test-secret' });
    const caught = await catchError(() => driver.get(MISSING));
    if (!isStorageError(caught)) {
      expect.unreachable('a coded storage error');
      return;
    }
    expect(caught.meta).toMatchObject({ disk: 'local' });
  });
});

describe('a memory not-found fix names the registered disk too', () => {
  test('the test disk answers a miss with the name the app registered', async () => {
    const driver = memoryDriver({ signingSecret: 'test-secret' });
    defineStorage({ disks: { uploads: driver } });
    namesUploads(await catchError(() => driver.get(MISSING)));
  });
});
