// The upload half of `/_storage`: a URL `grantUpload` minted must be PUT-able against the running
// app, and every refusal `acceptSignedUpload` owns must reach the caller as its own code. Until
// #523 the route table held only the GET, so a documented direct upload answered 405.

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
import type { Storage, UploadGrant } from '@ultimat3/storage';
import {
  DEFAULT_SIGNED_URL_BASE,
  defineStorage,
  grantUpload,
  localDriver,
  resetStorage,
  uploadPolicy,
} from '@ultimat3/storage';
import { servedStorage, storageRoutes } from './runtime-storage';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n');

let root = '';
let storage: Storage;

interface PutInit {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly orgId?: string | undefined;
}

/** The route the table mounts for PUT, driven the way the pipeline drives it. */
function uploadRoute(): Route {
  const route = storageRoutes({ storage }).find((candidate) => candidate.method === 'PUT');
  if (route === undefined) return expect.unreachable('storageRoutes mounts no PUT');
  return route;
}

async function put(grant: UploadGrant, init: PutInit): Promise<Response> {
  const url = new URL(grant.url, 'http://dev.test');
  const headers = { 'content-type': init.contentType ?? grant.contentType };
  const ctx: RequestContext = createRequestContext({
    url,
    method: 'PUT',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    requestHeaders: headers,
  });
  const [diskName = '', ...key] = url.pathname.slice(DEFAULT_SIGNED_URL_BASE.length + 1).split('/');
  ctx.params = { disk: diskName, key: key.join('/') };
  const orgId = 'orgId' in init ? init.orgId : 'org-1';
  ctx.actor = userActor({
    id: 'u-1',
    roles: ['member'],
    ...(orgId === undefined ? {} : { orgId }),
  });
  const request = new UltimateRequest(
    new Request(url, { method: 'PUT', headers, body: new Uint8Array(init.body) }),
    ctx,
  );
  return uploadRoute().handler(request, ctx);
}

const grantFor = (contentType: string, maxBytes = 1024): Promise<UploadGrant> =>
  grantUpload({
    disk: storage.disk('uploads'),
    orgId: 'org-1',
    policy: uploadPolicy({ maxBytes, allowedContentTypes: [contentType] }),
    request: { filename: contentType === 'application/pdf' ? 'a.pdf' : 'a.png', contentType },
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-storage-put-'));
  storage = defineStorage({
    disks: { uploads: localDriver({ root: join(root, '.storage') }) },
  });
});

afterEach(() => {
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

describe('unit · /_storage PUT · the signed upload (#523)', () => {
  test('a granted URL is PUT-able: 201 { key }, and the bytes are on the disk', async () => {
    const grant = await grantFor('image/png');
    const response = await put(grant, { body: PNG });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ key: grant.key });
    const stored = await storage.disk('uploads').get(grant.key);
    expect(stored.bytes).toEqual(PNG);
    expect(stored.object.contentType).toBe('image/png');
  });

  test("the grant's own type is the policy — a PDF grant is not refused as a non-image", async () => {
    const grant = await grantFor('application/pdf');
    expect((await put(grant, { body: PDF })).status).toBe(201);
  });

  test('the same route shape as the GET: authenticated, handler-enforced, never cached', () => {
    const route = uploadRoute();
    expect(route.path).toBe(`${DEFAULT_SIGNED_URL_BASE}/:disk/*key`);
    expect(route.meta.auth).toBe('required');
    expect(route.meta.enforcedBy).toBe('handler');
    expect(route.meta.cache?.mode).toBe('no-store');
  });

  test("another tenant's actor cannot spend the grant", async () => {
    const grant = await grantFor('image/png');
    await expect(put(grant, { body: PNG, orgId: 'org-2' })).rejects.toBeUltimateError(
      'X_STORAGE_ORG_MISMATCH',
    );
    await expect(put(grant, { body: PNG, orgId: undefined })).rejects.toBeUltimateError(
      'X_STORAGE_ORG_MISMATCH',
    );
  });

  test('a body over the SIGNED ceiling is refused, whatever the HTTP-wide limit', async () => {
    const grant = await grantFor('image/png', 32);
    const big = new Uint8Array(64);
    big.set(PNG);
    await expect(put(grant, { body: big })).rejects.toBeUltimateError('X_STORAGE_TOO_LARGE');
  });

  test('a body larger than the HTTP-wide limit is accepted when the grant allows it', async () => {
    const limit = defineHttpConfig({ rateLimit: { scope: 'process' } }).bodyLimitBytes;
    const grant = await grantFor('image/png', limit * 2);
    const big = new Uint8Array(limit + 16);
    big.set(PNG);
    expect((await put(grant, { body: big })).status).toBe(201);
  });

  test('a content type other than the signed one, or bytes that are not it, are refused', async () => {
    const grant = await grantFor('image/png');
    await expect(put(grant, { body: PNG, contentType: 'image/gif' })).rejects.toBeUltimateError(
      'X_STORAGE_URL_INVALID',
    );
    await expect(put(grant, { body: PDF })).rejects.toBeUltimateError('X_STORAGE_TYPE_REJECTED');
  });

  test('a disk the app does not have is the 404 the GET answers', async () => {
    const grant = await grantFor('image/png');
    const response = put(
      { ...grant, url: grant.url.replace('/uploads/', '/secrets/') },
      { body: PNG },
    );
    await expect(response).rejects.toBeUltimateError('X_STORAGE_NOT_FOUND');
  });
});

describe('unit · /_storage serves the APP’s disks (#524)', () => {
  test('the last defineStorage — the app’s — is what the routes read, per request', async () => {
    resetStorage();
    const host = defineStorage({
      disks: { object: localDriver({ root: join(root, '.host') }) },
    });
    const served = servedStorage(host);
    expect(served.diskNames).toEqual(['object']);
    // The app's module loads AFTER the boot built its disk, and declares its own.
    storage = defineStorage({
      disks: {
        uploads: localDriver({ root: join(root, '.storage') }),
        evidence: localDriver({ root: join(root, '.evidence') }),
      },
    });
    expect(served.diskNames).toEqual(['uploads', 'evidence']);
    const grant = await grantFor('image/png');
    const route = storageRoutes({ storage: served }).find((each) => each.method === 'PUT');
    expect(route).toBeDefined();
    expect((await put(grant, { body: PNG })).status).toBe(201);
    expect(await served.disk('uploads').exists(grant.key)).toBe(true);
  });

  test('with no registry at all, the host’s own disk is served', () => {
    resetStorage();
    const host = { defaultDisk: 'object', diskNames: ['object'], disk: () => storage.disk() };
    expect(servedStorage(host).diskNames).toEqual(['object']);
  });
});
