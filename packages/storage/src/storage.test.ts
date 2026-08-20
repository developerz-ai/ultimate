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
    copy: () => unused('copy'),
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

  // The registry is the only holder of the disk NAME, and a signed URL's `:disk` segment is that
  // name — so a driver has to be told it, and told it once.
  test('tells each driver the key it was registered under', () => {
    const told: string[] = [];
    const listening: StorageDriver = {
      ...stubDriver('local'),
      registerAs: (name: string): void => {
        told.push(name);
      },
    };
    defineStorage({ disks: { uploads: listening, media } });
    expect(told).toEqual(['uploads']);
  });

  // Last-name-wins would silently strand every URL minted under the first alias: the mounted
  // route resolves `:disk` through this map, so one driver answering to two names is one alias
  // 404ing at a time.
  test('refuses one driver instance registered under two names', () => {
    const shared = stubDriver('local');
    let caught: unknown;
    try {
      defineStorage({ disks: { uploads: shared, avatars: shared } });
    } catch (error) {
      caught = error;
    }
    expect(isUltimateError(caught) ? caught.code : '').toBe('X_CONFIG_INVALID');
    expect(isUltimateError(caught) ? caught.fix : '').toContain('localDriver(');
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

  // `config.disks[wanted]` walked the PROTOTYPE chain, so `disk('constructor')` answered with the
  // `Object` function and the next `.put()` was a bare `TypeError` from inside app code — the
  // opposite of "throws rather than lazily inventing a disk behind your back". `defineStorage`'s
  // own `names.includes(default)` check reads `Object.keys`, so `default: 'constructor'` was
  // refused while `disk('constructor')` was not: one function, two answers to one question.
  test('a name off Object.prototype is an unknown disk, not a function', () => {
    defineStorage({ disks: { uploads, media } });
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      let caught: unknown;
      try {
        disk(name);
      } catch (error) {
        caught = error;
      }
      expect(isStorageError(caught) ? caught.code : `no-throw for ${name}`).toBe(
        'X_STORAGE_DISK_UNKNOWN',
      );
    }
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
