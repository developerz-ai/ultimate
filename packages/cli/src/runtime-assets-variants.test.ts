// `/media` looked a variant up before it looked at the source, under a key that named neither the
// source's bytes nor its encoding. Each case replays one of the sequences that served wrong bytes,
// through the mounted route handler over a real local disk.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { blankRaster, encodeImage, probeImage, userActor } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { cacheControl, defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { ImageTransformDriver } from '@ultimat3/seo';
import type { Storage, StorageDriver, StorageObject } from '@ultimat3/storage';
import {
  defineStorage,
  localDriver,
  resetStorage,
  scopedKey,
  variantKey,
  variantRevision,
} from '@ultimat3/storage';
import { assetRoutes, MEDIA_BASE_PATH } from './runtime-assets';
import { AUTHORIZED_OBJECT_CACHE, STORAGE_READ_PERMISSION, storageRoutes } from './runtime-storage';

const KEY = scopedKey('o1', 'p', 'x.png');
const SHARED = 'brand/l.png';
const AUTHORIZED = cacheControl(AUTHORIZED_OBJECT_CACHE);
const png = (width: number, height: number): Uint8Array =>
  encodeImage(blankRaster(width, height, 'variants'), 'png');
/** A header `probeImage` reads, and no pixel: these cases stub the driver that would decode it. */
const GIF = new Uint8Array([
  ...new TextEncoder().encode('GIF89a'),
  0x80,
  0x02,
  0x40,
  0x01,
  0x00,
  0x00,
  0x00,
]);

let root = '';
let storage: Storage;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-variants-'));
  storage = defineStorage({
    disks: { local: localDriver({ root: join(root, '.storage') }) },
    shared: { local: ['brand/'] },
  });
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

interface CallOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly images?: ImageTransformDriver;
  readonly over?: Storage;
}

/** Through the route `x dev` and the container mount, as a reader in org `o1`. */
function call(key: string, query = '', options: CallOptions = {}): Promise<Response> {
  const routes: readonly Route[] = assetRoutes({
    root,
    storage: options.over ?? storage,
    ...(options.images === undefined ? {} : { images: options.images }),
  });
  const route = routes.find((candidate) => candidate.path === `${MEDIA_BASE_PATH}/*key`);
  if (route === undefined) return expect.unreachable('/media was not mounted');
  const url = new URL(`http://dev.test${MEDIA_BASE_PATH}/${key}${query}`);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'GET', role: 'web', config });
  ctx.params = { key };
  ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'o1' });
  const request = new Request(url, { headers: options.headers ?? {} });
  return Promise.resolve(route.handler(new UltimateRequest(request, ctx), ctx));
}

const sizeOf = async (response: Response) =>
  probeImage(new Uint8Array(await response.arrayBuffer()));

async function variantsOf(key: string): Promise<readonly string[]> {
  const page = await storage.disk().list({ prefix: `${key}@` });
  return page.rows.map((row) => row.key);
}

/** A driver that never decodes, counting how often it was asked. */
function countingDriver(): { readonly driver: ImageTransformDriver; calls: number } {
  const state = {
    calls: 0,
    driver: {
      name: 'stub',
      async transform() {
        state.calls += 1;
        return {
          bytes: png(16, 16),
          contentType: 'image/png',
          width: 16,
          height: 16,
        };
      },
      blurPlaceholder: async () => '',
    } satisfies ImageTransformDriver,
  };
  return state;
}

/** The registry, with the default disk's `stat` answering what a case needs it to. */
function reporting(answer: (object: StorageObject) => StorageObject): Storage {
  const disk: StorageDriver = storage.disk();
  const stat = async (key: string) => {
    const object = await disk.stat(key);
    return object === undefined ? undefined : answer(object);
  };
  const wrapped: StorageDriver = Object.assign(Object.create(disk), { stat });
  return {
    defaultDisk: storage.defaultDisk,
    diskNames: storage.diskNames,
    isShared: (name, key) => storage.isShared(name, key),
    disk: () => wrapped,
  };
}

describe('unit · /media · a variant follows its source', () => {
  test('a source overwritten under its key is what the next ?w= resizes', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    expect(await sizeOf(await call(KEY, '?w=320'))).toMatchObject({ width: 320, height: 160 });

    await storage.disk().put(KEY, png(640, 640), { contentType: 'image/png' });
    expect(await sizeOf(await call(KEY, '?w=320'))).toMatchObject({ width: 320, height: 320 });
  });

  test('a deleted source is X_STORAGE_NOT_FOUND, with its variant still on the disk', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    expect((await call(KEY, '?w=320')).status).toBe(200);
    await storage.disk().delete(KEY);

    expect(await variantsOf(KEY)).toHaveLength(1);
    await expect(call(KEY, '?w=320')).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
    await expect(call(KEY)).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
  });

  test('?w= and ?w=&f=webp are two encodings, in either order of first request', async () => {
    const keepFirst = scopedKey('o1', 'p', 'keep-first.png');
    const webpFirst = scopedKey('o1', 'p', 'webp-first.png');
    for (const key of [keepFirst, webpFirst]) {
      await storage.disk().put(key, png(640, 320), { contentType: 'image/png' });
    }
    const type = (response: Response) => response.headers.get('content-type');

    expect(type(await call(keepFirst, '?w=320'))).toBe('image/png');
    expect(type(await call(keepFirst, '?w=320&f=webp'))).toBe('image/webp');

    expect(type(await call(webpFirst, '?w=320&f=webp'))).toBe('image/webp');
    expect(type(await call(webpFirst, '?w=320'))).toBe('image/png');

    // And again, now that both answers come off the disk.
    expect(type(await call(webpFirst, '?w=320&f=webp'))).toBe('image/webp');
    expect(type(await call(webpFirst, '?w=320'))).toBe('image/png');
    expect(await variantsOf(webpFirst)).toHaveLength(2);
  });

  test('a source no variant format names is served and never stored', async () => {
    const key = scopedKey('o1', 'p', 'a.gif');
    await storage.disk().put(key, GIF, { contentType: 'image/gif' });
    const stub = countingDriver();

    const response = await call(key, '?w=320', { images: stub.driver });
    expect(response.status).toBe(200);
    expect(stub.calls).toBe(1);
    expect(await variantsOf(key)).toEqual([]);
  });

  test('a source whose etag is unknowable is served and never stored, and offers no validator', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const response = await call(KEY, '?w=320', {
      over: reporting((object) => ({ ...object, etag: '' })),
    });
    expect((await sizeOf(response)).width).toBe(320);
    expect(response.headers.get('etag')).toBeNull();
    expect(await variantsOf(KEY)).toEqual([]);
  });

  test('a source replaced between the stat and the read is served and never stored', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const response = await call(KEY, '?w=320', {
      over: reporting((object) => ({ ...object, etag: '0123456789abcdef' })),
    });
    expect((await sizeOf(response)).width).toBe(320);
    expect(await variantsOf(KEY)).toEqual([]);
  });

  test('the stored variant is keyed on the bytes it was made from', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    await call(KEY, '?w=320');
    const object = await storage.disk().stat(KEY);
    const revision = variantRevision(object?.etag ?? '');
    expect(revision).toMatch(/^[0-9a-f]{8}$/);
    expect(await variantsOf(KEY)).toEqual([
      variantKey(KEY, { width: 320, format: 'png', revision }),
    ]);
  });
});

describe('unit · a stored variant, read by its own key', () => {
  /** The one stored variant of `KEY`, as its key alone names it. */
  async function storedVariant(): Promise<string> {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    await call(KEY, '?w=320');
    const [variant] = await variantsOf(KEY);
    return variant ?? expect.unreachable('?w=320 stored no variant');
  }
  const viaStorage = (key: string): Promise<Response> => {
    const route = storageRoutes({ storage })[0];
    if (route === undefined) return expect.unreachable('/_storage was not mounted');
    const url = new URL(`http://dev.test/_storage/local/${key}`);
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = requestContext({ url, method: 'GET', role: 'web', config });
    ctx.params = { disk: 'local', key };
    ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'o1' });
    return Promise.resolve(route.handler(new UltimateRequest(new Request(url), ctx), ctx));
  };

  test('is served while its source stands', async () => {
    const variant = await storedVariant();
    expect((await call(variant)).status).toBe(200);
    expect((await viaStorage(variant)).status).toBe(200);
  });

  test('is X_STORAGE_NOT_FOUND on both routes once the source is deleted', async () => {
    const variant = await storedVariant();
    await storage.disk().delete(KEY);
    expect(await storage.disk().exists(variant)).toBe(true);
    await expect(call(variant)).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
    await expect(call(variant, '?w=16')).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
    await expect(viaStorage(variant)).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
  });

  test('is X_STORAGE_NOT_FOUND once the source is overwritten: it names bytes no one holds', async () => {
    const variant = await storedVariant();
    await storage.disk().put(KEY, png(640, 640), { contentType: 'image/png' });
    await expect(call(variant)).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
    await expect(viaStorage(variant)).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
  });

  test('a key that only resembles one, with no revision, is an ordinary key', async () => {
    const plain = scopedKey('o1', 'p', 'logo@2x.png');
    await storage.disk().put(plain, png(16, 16), { contentType: 'image/png' });
    expect((await call(plain)).status).toBe(200);
  });
});

describe('unit · /media · what a cache may keep', () => {
  test('a shared key is not public, and neither is a variant of one', async () => {
    await storage.disk().put(SHARED, png(640, 320), { contentType: 'image/png' });
    for (const query of ['', '?w=320']) {
      const control = (await call(SHARED, query)).headers.get('cache-control');
      expect(control).toBe(AUTHORIZED);
      expect(control).not.toContain('public');
      expect(control).not.toContain('immutable');
    }
  });

  test('a second request with if-none-match is 304, and decodes nothing', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const stub = countingDriver();
    const first = await call(KEY, '?w=320', { images: stub.driver });
    const etag = first.headers.get('etag') ?? expect.unreachable('a variant carries no ETag');
    expect(stub.calls).toBe(1);

    const again = await call(KEY, '?w=320', {
      images: stub.driver,
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('cache-control')).toBe(AUTHORIZED);
    expect(await again.text()).toBe('');
    expect(stub.calls).toBe(1);
  });

  test('the validator names the transform and the source: neither answers for the other', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const etagOf = async (query: string) => (await call(KEY, query)).headers.get('etag');
    const narrow = await etagOf('?w=320');
    const webp = await etagOf('?w=320&f=webp');
    const original = await etagOf('');
    expect(new Set([narrow, webp, original]).size).toBe(3);

    await storage.disk().put(KEY, png(640, 640), { contentType: 'image/png' });
    expect(await etagOf('?w=320')).not.toBe(narrow);
    expect(await etagOf('')).not.toBe(original);
  });

  test('the object itself answers a Range and a 304 through the one response', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const whole = await call(KEY);
    const etag = whole.headers.get('etag') ?? expect.unreachable('an object carries no ETag');
    expect((await call(KEY, '', { headers: { 'if-none-match': etag } })).status).toBe(304);
    const window = await call(KEY, '', { headers: { range: 'bytes=0-7' } });
    expect(window.status).toBe(206);
    expect(new Uint8Array(await window.arrayBuffer())).toHaveLength(8);
  });

  test('a variant answers a Range too', async () => {
    await storage.disk().put(KEY, png(640, 320), { contentType: 'image/png' });
    const window = await call(KEY, '?w=320', { headers: { range: 'bytes=0-7' } });
    expect(window.status).toBe(206);
    expect(new Uint8Array(await window.arrayBuffer())).toHaveLength(8);
  });
});
