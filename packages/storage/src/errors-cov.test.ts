// The refusals no other test raised: `keyUnshared`'s shape, and `X_STORAGE_MULTIPART_UNSUPPORTED`
// from a real `grantMultipart` against a disk whose driver declares no multipart capability.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { memoryStorageDriver } from './driver-memory';
import { isStorageError, keyUnshared } from './errors';
import { grantMultipart } from './grant-multipart';
import { uploadPolicy } from './upload';

describe('keyUnshared', () => {
  test('carries its code, the disk and key, and a fix that never quotes the refused key', () => {
    const error = keyUnshared('uploads', 'db-export/dump.sql');
    expect(error.code).toBe('X_STORAGE_KEY_UNSHARED');
    expect(error.meta).toEqual({ disk: 'uploads', key: 'db-export/dump.sql' });
    expect(error.cause).toContain('"db-export/dump.sql" on disk "uploads"');
    expect(error.fix).toContain("shared: { uploads: ['brand/'] }");
    expect(error.fix).not.toContain('db-export');
  });
});

describe('grantMultipart on a disk without multipart', () => {
  test('refuses with X_STORAGE_MULTIPART_UNSUPPORTED naming the disk, before opening anything', async () => {
    const memory = memoryStorageDriver({ signingSecret: 'test-secret', clock: frozenClock(0) });
    const disk: StorageDriver = { ...memory, name: 'thirdparty', multipart: undefined };
    const error = await grantMultipart({
      disk,
      orgId: 'org-1',
      request: { filename: 'film.mp4', contentType: 'video/mp4', size: 10 },
      policy: uploadPolicy({ maxBytes: 1 << 20, allowedContentTypes: ['video/mp4'] }),
    }).then(
      () => expect.unreachable('a disk with no multipart granted a session'),
      (thrown: unknown) => thrown,
    );
    expect(isStorageError(error) ? error.code : String(error)).toBe(
      'X_STORAGE_MULTIPART_UNSUPPORTED',
    );
    expect(isStorageError(error) ? error.meta?.['disk'] : undefined).toBe('thirdparty');
  });
});
