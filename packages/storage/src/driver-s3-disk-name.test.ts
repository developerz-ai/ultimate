// `X_STORAGE_NOT_FOUND`'s fix is a call to paste — `disk('<name>').list(...)` — so the name in it
// must be the one `defineStorage` registered, never the driver kind: `disk('s3')` on an app whose
// s3 disk is called `uploads` is `X_STORAGE_DISK_UNKNOWN`, a second error from the first one's fix.

import { afterEach, describe, expect, test } from 'bun:test';
import { s3Driver } from './driver-s3';
import { catchError, codeOf, FakeS3Client, s3Error } from './driver-s3-fixture';
import { isStorageError } from './errors';
import { defineStorage, resetStorage } from './storage';

afterEach(() => {
  resetStorage();
});

const MISSING = 'org/org-1/missing.txt';

const uploads = (): {
  readonly fake: FakeS3Client;
  readonly driver: ReturnType<typeof s3Driver>;
} => {
  const fake = new FakeS3Client();
  const driver = s3Driver({ bucket: 'b', client: fake });
  defineStorage({ disks: { uploads: driver } });
  return { fake, driver };
};

const namesUploads = (caught: unknown): void => {
  expect(codeOf(caught)).toBe('X_STORAGE_NOT_FOUND');
  if (!isStorageError(caught)) {
    expect.unreachable('a coded storage error');
    return;
  }
  expect(caught.fix).toContain("disk('uploads').list(");
  expect(caught.fix).not.toContain("disk('s3')");
  expect(caught.cause).toContain('disk "uploads"');
  expect(caught.meta).toMatchObject({ disk: 'uploads' });
};

describe('a not-found fix names the registered disk', () => {
  test('get, stream and copy of a missing key', async () => {
    const { driver } = uploads();
    namesUploads(await catchError(() => driver.get(MISSING)));
    namesUploads(await catchError(() => driver.stream(MISSING)));
    namesUploads(await catchError(() => driver.copy(MISSING, 'org/org-1/to.txt')));
  });

  test('an object deleted between exists() and the read — the provider`s own 404', async () => {
    const { fake, driver } = uploads();
    await driver.put('org/org-1/gone.txt', new TextEncoder().encode('x'));
    fake.failBodyWith = s3Error('NoSuchKey', 404, 'org/org-1/gone.txt');
    namesUploads(await catchError(() => driver.get('org/org-1/gone.txt')));
  });

  test('a driver no registry named still answers, under its kind', async () => {
    const driver = s3Driver({ bucket: 'b', client: new FakeS3Client() });
    const caught = await catchError(() => driver.get(MISSING));
    if (!isStorageError(caught)) return expect.unreachable('a coded storage error');
    expect(caught.meta).toMatchObject({ disk: 's3' });
  });
});
