// A stored object is served from the app's own origin, with the stored content type and nothing
// else (s1-sec L6): an uploaded `text/html` or SVG opened by URL ran on the app's origin. Both
// surfaces that serve stored bytes are asked, for both kinds of object.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { createRaster, encodeImage, userActor } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { Storage } from '@ultimat3/storage';
import {
  DEFAULT_SIGNED_URL_BASE,
  defineStorage,
  localDriver,
  resetStorage,
} from '@ultimat3/storage';
import { assetRoutes, MEDIA_BASE_PATH } from './runtime-assets';
import { STORAGE_READ_PERMISSION, storageRoutes } from './runtime-storage';
import { isInlineSafe, storedObjectHeaders } from './stored-object-headers';

let root = '';
let storage: Storage;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'x-stored-headers-'));
  storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.storage') }) } });
  await storage.disk().put('brand/logo.png', encodeImage(createRaster(4, 4, 'logo'), 'png'), {
    contentType: 'image/png',
  });
  await storage.disk().put('brand/page.html', new TextEncoder().encode('<script>1</script>'), {
    contentType: 'text/html',
  });
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetStorage();
  clearPermissions();
  clearRoles();
});

async function serve(route: Route | undefined, path: string, params: Record<string, string>) {
  expect(route).toBeDefined();
  const url = new URL(`http://app.test${path}`);
  const ctx = createRequestContext({
    url,
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  ctx.params = params;
  ctx.actor = userActor({ id: 'u-1', roles: ['member'] });
  return (route as Route).handler(new UltimateRequest(new Request(url), ctx), ctx);
}

const viaStorage = (key: string) =>
  serve(storageRoutes({ storage })[0], `${DEFAULT_SIGNED_URL_BASE}/local/${key}`, {
    disk: 'local',
    key,
  });

const viaMedia = (key: string) =>
  serve(
    assetRoutes({ root, storage }).find((route) => route.path === `${MEDIA_BASE_PATH}/*key`),
    `${MEDIA_BASE_PATH}/${key}`,
    { key },
  );

describe('unit · a stored object, presented', () => {
  test('only raster images, audio and video are inline — never svg, html or xml', () => {
    expect(isInlineSafe('image/png')).toBe(true);
    expect(isInlineSafe('IMAGE/JPEG; charset=binary')).toBe(true);
    expect(isInlineSafe('video/mp4')).toBe(true);
    for (const type of ['image/svg+xml', 'text/html', 'application/xml', 'application/pdf', '']) {
      expect(storedObjectHeaders(type)).toEqual({
        'content-disposition': 'attachment',
        'content-security-policy': 'sandbox',
      });
    }
  });

  test('/_storage: an uploaded html file is a sandboxed download, a png is shown', async () => {
    const html = await viaStorage('brand/page.html');
    expect(html.headers.get('content-disposition')).toBe('attachment');
    expect(html.headers.get('content-security-policy')).toBe('sandbox');
    expect((await viaStorage('brand/logo.png')).headers.get('content-disposition')).toBeNull();
    expect((await viaStorage('brand/logo.png')).headers.get('content-security-policy')).toBeNull();
  });

  test('/media: an uploaded html file is a sandboxed download, a png is shown', async () => {
    const html = await viaMedia('brand/page.html');
    expect(html.headers.get('content-disposition')).toBe('attachment');
    expect(html.headers.get('content-security-policy')).toBe('sandbox');
    expect((await viaMedia('brand/logo.png')).headers.get('content-disposition')).toBeNull();
  });
});
