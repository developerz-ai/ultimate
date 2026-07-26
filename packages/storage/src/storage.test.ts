import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { isStorageError, storageNotImplemented } from './errors';
import { defineStorage, disk, resetStorage, storage } from './storage';

/** A driver stub: `defineStorage` must not touch the file system or a socket to resolve a name. */
function stubDriver(name: string): StorageDriver {
  const unused = (op: string): Promise<never> =>
    Promise.reject(
      storageNotImplemented(`${name}.${op} in a resolution test`, 'use a real driver'),
    );
  return {
    name,
    put: () => unused('put'),
    get: () => unused('get'),
    stream: () => unused('stream'),
    delete: () => Promise.resolve(),
    exists: () => Promise.resolve(false),
    list: () => Promise.resolve({ objects: [], truncated: false }),
    signedUrl: () => Promise.resolve(''),
  };
}

const uploads = stubDriver('local');
const media = stubDriver('s3');

beforeEach(() => {
  resetStorage();
});

describe('defineStorage', () => {
  test('resolves named disks and defaults to the first declared one', () => {
    const configured = defineStorage({ disks: { uploads, media } });
    expect(configured.defaultDisk).toBe('uploads');
    expect(configured.diskNames).toEqual(['uploads', 'media']);
    expect(configured.disk()).toBe(uploads);
    expect(configured.disk('media')).toBe(media);
  });

  test('honours an explicit default', () => {
    expect(defineStorage({ disks: { uploads, media }, default: 'media' }).disk()).toBe(media);
  });

  test('installs itself as the module-level storage', () => {
    defineStorage({ disks: { uploads, media } });
    expect(storage().disk('media')).toBe(media);
    expect(disk('uploads')).toBe(uploads);
  });

  test('rejects a default that is not a configured disk', () => {
    let caught: unknown;
    try {
      defineStorage({ disks: { uploads }, default: 'media' });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) ? caught.code : '').toBe('X_CONFIG_INVALID');
  });

  test('rejects an empty disk map', () => {
    let caught: unknown;
    try {
      defineStorage({ disks: {} });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) ? caught.code : '').toBe('X_CONFIG_INVALID');
  });
});

describe('disk()', () => {
  test('an unknown disk names the disks that DO exist', () => {
    defineStorage({ disks: { uploads, media } });
    let caught: unknown;
    try {
      disk('nope');
    } catch (error) {
      caught = error;
    }
    expect(isStorageError(caught)).toBe(true);
    const error = isStorageError(caught) ? caught : undefined;
    expect(error?.code).toBe('X_STORAGE_DISK_UNKNOWN');
    expect(error?.cause).toContain('uploads');
    expect(error?.cause).toContain('media');
    expect(error?.fix).toContain('app.config.ts');
  });

  test('using storage before defineStorage is a config error, not undefined', () => {
    let caught: unknown;
    try {
      storage();
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) ? caught.code : '').toBe('X_CONFIG_INVALID');
  });
});
