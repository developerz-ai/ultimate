// An uploaded file is only served if a running app answers with its bytes, and only SAFE if the
// caller had to get past the app's own policy first. These tests drive the route `x dev` mounts —
// the denied read, the foreign tenant, the traversal attempt and the object that is not there —
// because every one of those is a case where answering with bytes is the bug.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory helper, and a shared root would let one
// case's object decide the next case's answer.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { userActor } from '@ultimat3/core';
import type { RequestContext, Route } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { Storage } from '@ultimat3/storage';
import {
  DEFAULT_SIGNED_URL_BASE,
  defineStorage,
  localDriver,
  resetStorage,
  scopedKey,
} from '@ultimat3/storage';
import { etagMatches, parseByteRange, STORAGE_READ_PERMISSION, storageRoutes } from './dev-storage';

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const KEY = scopedKey('org-1', 'avatars', 'a.png');

let root = '';
let storage: Storage;

/** The reader's org and role; every case varies exactly one of the two. */
const reader = (roles: readonly string[], orgId: string | undefined) =>
  userActor({ id: 'u-1', roles: [...roles], ...(orgId === undefined ? {} : { orgId }) });

interface CallInit {
  readonly disk?: string;
  readonly key?: string;
  readonly actor?: ReturnType<typeof reader>;
  readonly headers?: Record<string, string>;
}

/**
 * The route, driven the way the pipeline drives it: params off the matched pattern, the actor in
 * the context slot the `auth` stage fills. The trie is `@ultimat3/http`'s and is not re-tested.
 */
async function call(routes: readonly Route[], init: CallInit = {}): Promise<Response> {
  const route = routes[0];
  expect(route?.path).toBe(`${DEFAULT_SIGNED_URL_BASE}/:disk/*key`);
  if (route === undefined) throw new Error('no route');
  const key = init.key ?? KEY;
  const url = new URL(`http://dev.test${DEFAULT_SIGNED_URL_BASE}/${init.disk ?? 'local'}/${key}`);
  const ctx: RequestContext = createRequestContext({
    url,
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    ...(init.headers === undefined ? {} : { requestHeaders: init.headers }),
  });
  ctx.params = { disk: init.disk ?? 'local', key };
  ctx.actor = init.actor ?? reader(['member'], 'org-1');
  // Spread conditionally, exactly as `requestHeaders` is four lines up: `RequestInit.headers` is
  // optional, and under `exactOptionalPropertyTypes` an explicit `undefined` is not "no headers".
  const request = new UltimateRequest(
    new Request(url, init.headers === undefined ? {} : { headers: init.headers }),
    ctx,
  );
  return route.handler(request, ctx);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-storage-'));
  storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.storage') }) } });
  await storage.disk().put(KEY, BYTES, { contentType: 'image/png' });
  // The app's own declarations: one permission, one role that grants it. Nothing here is the
  // framework's — an app that declares neither is the "no policy" case, covered below.
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] }, guest: { grants: [] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

describe('unit · dev storage · the served object', () => {
  test('answers with the STORED content type and a content length, not a guess from the URL', async () => {
    // The key says `.png` and the object was stored as a gif: the object wins, or a sniffing
    // browser is deciding the type of somebody else's upload.
    await storage.disk().put(KEY, BYTES, { contentType: 'image/gif' });
    const response = await call(storageRoutes({ storage }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  test('the validator is the driver etag, and a matching one costs no bytes', async () => {
    const routes = storageRoutes({ storage });
    const first = await call(routes);
    const etag = first.headers.get('etag') ?? '';
    const stored = (await storage.disk().get(KEY)).object.etag;
    expect(etag).toBe(`"${stored}"`);

    const again = await call(routes, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
  });

  test('the route declares a private cache posture that varies on identity', () => {
    const [route] = storageRoutes({ storage });
    // Declared, not applied here: the pipeline's `cache-headers` stage is what writes the header.
    expect(route?.meta.cache).toMatchObject({ mode: 'private', maxAgeSeconds: 0 });
    expect(route?.meta.cache?.vary).toEqual(['authorization', 'cookie']);
    expect(route?.meta.auth).toBe('required');
    expect(route?.meta.enforcedBy).toBe('handler');
  });

  test('a Range answers 206 with just that window', async () => {
    const response = await call(storageRoutes({ storage }), { headers: { range: 'bytes=2-4' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(`bytes 2-4/${BYTES.byteLength}`);
    expect(response.headers.get('content-length')).toBe('3');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES.subarray(2, 5));
  });

  test('a Range past the end is 416, never a silent full body', async () => {
    const response = await call(storageRoutes({ storage }), { headers: { range: 'bytes=99-' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${BYTES.byteLength}`);
  });
});

describe('unit · dev storage · authorization', () => {
  test('an actor whose role does not grant the permission is refused', async () => {
    await expect(
      call(storageRoutes({ storage }), { actor: reader(['guest'], 'org-1') }),
    ).rejects.toBeUltimateError('X_FORBIDDEN');
  });

  test('a role that grants it is served the bytes', async () => {
    const response = await call(storageRoutes({ storage }), { actor: reader(['member'], 'org-1') });
    expect(response.status).toBe(200);
  });

  test('an app that never declared the permission refuses every read', async () => {
    // "No policy" is not "public": with a permission set that has no `storage:read`, `can()`
    // refuses at the door and names the `definePermissions` edit that fixes it.
    clearPermissions();
    definePermissions(['post:read']);
    await expect(call(storageRoutes({ storage }))).rejects.toBeUltimateError(
      'X_PERMISSION_UNKNOWN',
    );
  });

  test('an anonymous caller is told to log in, not that the object is forbidden', async () => {
    // The pipeline 401s an `auth: 'required'` route before the handler; this is the handler
    // holding the same line on its own, with the code the decision carried rather than a
    // flattened 403 — so the guarantee does not depend on which surface called it.
    const route = storageRoutes({ storage })[0];
    const url = new URL(`http://dev.test${DEFAULT_SIGNED_URL_BASE}/local/${KEY}`);
    const ctx = createRequestContext({
      url,
      method: 'GET',
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    ctx.params = { disk: 'local', key: KEY };
    const answer = async (): Promise<Response> =>
      route === undefined
        ? new Response(null)
        : route.handler(new UltimateRequest(new Request(url), ctx), ctx);
    await expect(answer()).rejects.toBeUltimateError('X_UNAUTHENTICATED');
  });
});

describe('unit · dev storage · what a refusal must not disclose', () => {
  test('another tenant’s object is 404, not 403 — and the same 404 whether it exists or not', async () => {
    const foreign = scopedKey('org-2', 'avatars', 'a.png');
    await storage.disk().put(foreign, BYTES, { contentType: 'image/png' });
    const routes = storageRoutes({ storage });

    await expect(call(routes, { key: foreign })).rejects.toBeUltimateError(
      'X_STORAGE_ORG_MISMATCH',
    );
    await expect(
      call(routes, { key: scopedKey('org-2', 'avatars', 'never-written.png') }),
    ).rejects.toBeUltimateError('X_STORAGE_ORG_MISMATCH');
  });

  test('an actor with no org cannot read a tenant-scoped object', async () => {
    await expect(
      call(storageRoutes({ storage }), { actor: reader(['member'], undefined) }),
    ).rejects.toBeUltimateError('X_STORAGE_ORG_MISMATCH');
  });

  test('a key nobody scoped is served on the policy alone', async () => {
    await storage.disk().put('brand/logo.png', BYTES, { contentType: 'image/png' });
    const response = await call(storageRoutes({ storage }), { key: 'brand/logo.png' });
    expect(response.status).toBe(200);
  });

  test('a missing object is a coded 404 carrying a runnable fix', async () => {
    await expect(
      call(storageRoutes({ storage }), { key: scopedKey('org-1', 'avatars', 'gone.png') }),
    ).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
  });

  test('an unknown disk answers 404 rather than naming the configured disks', async () => {
    // `X_STORAGE_DISK_UNKNOWN`'s cause lists every disk in the app; a caller who guessed a name
    // must not be handed the list, and it is a 500 in the status table besides.
    await expect(call(storageRoutes({ storage }), { disk: 'secrets' })).rejects.toBeUltimateError(
      'X_STORAGE_NOT_FOUND',
    );
  });
});

describe('unit · dev storage · path safety', () => {
  // Each of these is a key the `*key` wildcard can carry. Two guards stand behind them and both
  // are load-bearing: this route's own `assertSafeKey`, which refuses before a disk is even
  // chosen, and the driver's, which every method starts with. Drop the route's and the tenant
  // cases below stop answering `X_STORAGE_PATH_UNSAFE` — the traversal is then classified by the
  // org check, which is a different question with a different status.
  const traversals: readonly [string, string][] = [
    ['parent traversal', '../../etc/passwd'],
    ['traversal out of the tenant prefix', 'org/org-1/../../org/org-2/a.png'],
    ['absolute path', '/etc/passwd'],
    ['percent-encoded separator', '..%2fetc/passwd'],
    ['double-encoded dots', '%2e%2e/etc/passwd'],
    ['backslash', 'org\\org-1\\a.png'],
    ['NUL byte', 'org/org-1/a\u0000.png'],
    ['empty key', ''],
  ];

  for (const [label, key] of traversals) {
    test(`refuses ${label} before any disk read`, async () => {
      await expect(call(storageRoutes({ storage }), { key })).rejects.toBeUltimateError(
        'X_STORAGE_PATH_UNSAFE',
      );
    });
  }

  test('a file next to the disk root stays unreachable through the route', async () => {
    // The disk root is `<root>/.storage`, so `../secret.txt` is a REAL file one level up: a
    // handler that joined the key onto the root would serve it. Asserting on the bytes, not only
    // on the code, is what makes this a test of the escape rather than of the error message.
    await Bun.write(join(root, 'secret.txt'), 'another tenant data');
    for (const key of ['../secret.txt', 'org/org-1/../../secret.txt', '/etc/hostname']) {
      await expect(call(storageRoutes({ storage }), { key })).rejects.toBeUltimateError(
        'X_STORAGE_PATH_UNSAFE',
      );
    }
    // The target really is there and really is outside the disk: without this the loop above
    // could pass against a file that never existed, which would prove nothing.
    expect(await Bun.file(join(root, 'secret.txt')).text()).toBe('another tenant data');
    expect(await storage.disk().exists('secret.txt')).toBe(false);
  });

  test('an escaping key is refused even for an actor who may read', async () => {
    // The guard is not a permission check standing in for the policy: the policy already allowed
    // this actor, and the key is still refused.
    await expect(
      call(storageRoutes({ storage }), { actor: reader(['member'], 'org-1'), key: '../../secret' }),
    ).rejects.toBeUltimateError('X_STORAGE_PATH_UNSAFE');
  });
});

describe('unit · dev storage · conditional and range parsing', () => {
  test('a weak validator, a list and a star all match', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"other", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });

  test('the ranges a media element actually sends', () => {
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
    expect(parseByteRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    // A suffix longer than the object is the whole object.
    expect(parseByteRange('bytes=-99', 10)).toEqual({ start: 0, end: 9 });
  });

  test('unsatisfiable and ignorable are different answers', () => {
    expect(parseByteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=4-2', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
    // A SUFFIX against a zero-byte object. The non-suffix branch already answered this through
    // `start >= size`; the suffix branch had no such test, so `bytes=-5` on an empty object
    // answered `{ start: 0, end: -1 }` and the route rendered `content-range: bytes 0--1/0` with
    // status 206. RFC 9110 requires 416 — nothing satisfies a range over no bytes at all.
    expect(parseByteRange('bytes=-5', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-1', 0)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-99', 0)).toBe('unsatisfiable');
    // Multi-range and nonsense are ignored, not refused: the whole object is a valid answer.
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeUndefined();
    expect(parseByteRange('items=0-1', 10)).toBeUndefined();
    expect(parseByteRange(null, 10)).toBeUndefined();
  });
});
