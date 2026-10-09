import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError, NotImplementedError } from '@ultimat3/core';
import type { StorageDriver } from './driver';
import { isStorageError } from './errors';
import { definedStorage, defineStorage, disk, resetStorage, storage } from './storage';

/** A driver stub: `defineStorage` must not touch the file system or a socket to resolve a name. */
function stubDriver(name: string): StorageDriver {
  const unused = (op: string): Promise<never> =>
    Promise.reject(
      new NotImplementedError({
        cause: `${name}.${op} is not implemented in a resolution test`,
        fix: 'use a real driver',
      }),
    );
  return {
    name,
    put: () => unused('put'),
    get: () => unused('get'),
    stat: () => unused('stat'),
    stream: () => unused('stream'),
    copy: () => unused('copy'),
    delete: () => Promise.resolve(),
    exists: () => Promise.resolve(false),
    list: () => Promise.resolve({ rows: [], nextCursor: null, hasMore: false } as const),
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

describe('shared prefixes', () => {
  // The opt-in a serving route reads: a key outside every `org/<id>/` prefix is NOBODY's until the
  // app names its prefix here, per disk. Refused at boot rather than at the first read, because a
  // prefix that can never match is a declaration that silently shares nothing.
  test('nothing is shared until a prefix is declared', () => {
    const configured = defineStorage({ disks: { uploads, media } });
    expect(configured.isShared('uploads', 'brand/logo.png')).toBe(false);
  });

  test('a declared prefix shares its keys on that disk only, a whole segment at a time', () => {
    const configured = defineStorage({
      disks: { uploads, media },
      shared: { uploads: ['brand/'] },
    });
    expect(configured.isShared('uploads', 'brand/logo.png')).toBe(true);
    expect(configured.isShared('uploads', 'brand/a/b.png')).toBe(true);
    expect(configured.isShared('uploads', 'brandish/logo.png')).toBe(false);
    expect(configured.isShared('media', 'brand/logo.png')).toBe(false);
    expect(configured.isShared('nope', 'brand/logo.png')).toBe(false);
  });

  test('a tenant-scoped key is never shared, whatever the prefix says', () => {
    const configured = defineStorage({ disks: { uploads }, shared: { uploads: ['brand/'] } });
    expect(configured.isShared('uploads', 'org/o1/brand/logo.png')).toBe(false);
  });

  const refusals: readonly [string, Readonly<Record<string, readonly string[]>>][] = [
    ['a disk that is not declared', { evidence: ['brand/'] }],
    ['a prefix without its trailing slash', { uploads: ['brand'] }],
    ['the whole disk', { uploads: ['/'] }],
    ['an empty prefix', { uploads: [''] }],
    ['a tenant prefix', { uploads: ['org/'] }],
    ['a tenant prefix in another case', { uploads: ['Org/o1/'] }],
    ['a traversal', { uploads: ['../brand/'] }],
  ];
  for (const [label, shared] of refusals) {
    test(`refuses ${label}`, () => {
      let caught: unknown;
      try {
        defineStorage({ disks: { uploads }, shared });
      } catch (error) {
        caught = error;
      }
      expect(isUltimateError(caught) && caught.code).toBe('X_CONFIG_INVALID');
    });
  }
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

describe('definedStorage()', () => {
  test('is undefined before any defineStorage, never a throw', () => {
    expect(definedStorage()).toBeUndefined();
  });

  test('is the LAST defineStorage — the registry an app writes through `disk()` (#524)', () => {
    defineStorage({ disks: { object: stubDriver('host') } });
    const app = defineStorage({ disks: { uploads, evidence: media } });
    expect(definedStorage()).toBe(app);
    expect(definedStorage()?.diskNames).toEqual(['uploads', 'evidence']);
  });
});
