// `warmVariants` (storage) then `/media?w=` (this route): the warmed variant is a hit — the
// transform driver is never asked, so no visitor pays the decode the upload's job already paid.

import { afterEach, beforeEach, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { blankRaster, encodeImage, probeImage, userActor } from '@ultimat3/core';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { ImageTransformDriver } from '@ultimat3/seo';
import type { Storage } from '@ultimat3/storage';
import {
  defineStorage,
  localDriver,
  resetStorage,
  scopedKey,
  warmVariants,
} from '@ultimat3/storage';
import { assetRoutes, MEDIA_BASE_PATH } from './runtime-assets';
import { STORAGE_READ_PERMISSION } from './runtime-storage';

const KEY = scopedKey('o1', 'p', 'hero.png');

let root = '';
let storage: Storage;
let asked = 0;

/** Answers, and counts: a call here is a decode the warm-up was supposed to have paid. */
const driver: ImageTransformDriver = {
  name: 'counting',
  async transform() {
    asked += 1;
    return {
      bytes: encodeImage(blankRaster(1, 1), 'png'),
      contentType: 'image/png',
      width: 1,
      height: 1,
    };
  },
  blurPlaceholder: async () => '',
};

beforeEach(() => {
  asked = 0;
  root = mkdtempSync(join(tmpdir(), 'x-warm-'));
  storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.storage') }) } });
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(() => {
  clearPermissions();
  clearRoles();
  resetStorage();
  rmSync(root, { recursive: true, force: true });
});

async function media(query: string): Promise<Response> {
  const route = assetRoutes({ root, storage, images: driver }).find(
    (candidate) => candidate.path === `${MEDIA_BASE_PATH}/*key`,
  );
  if (route === undefined) return expect.unreachable('/media was not mounted');
  const url = new URL(`http://dev.test${MEDIA_BASE_PATH}/${KEY}${query}`);
  const ctx = requestContext({
    url,
    method: 'GET',
    role: 'web',
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });
  ctx.params = { key: KEY };
  ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'o1' });
  return route.handler(new UltimateRequest(new Request(url), ctx), ctx);
}

test('a warmed width answers from the disk, in both the named and the source format', async () => {
  await storage.disk().put(KEY, encodeImage(blankRaster(640, 320), 'png'), {
    contentType: 'image/png',
  });
  const warmed = await warmVariants({
    disk: storage.disk(),
    key: KEY,
    widths: [320],
    formats: ['webp', 'png'],
  });
  expect(warmed.failed).toEqual([]);

  const webp = await media('?w=320&f=webp');
  expect(webp.headers.get('content-type')).toBe('image/webp');
  expect(probeImage(new Uint8Array(await webp.arrayBuffer())).width).toBe(320);
  // `?w=` alone keeps the source's encoding, and that key was warmed too.
  expect(probeImage(new Uint8Array(await (await media('?w=320')).arrayBuffer())).width).toBe(320);
  expect(asked).toBe(0);
  // The control: an unwarmed width DOES reach the driver, so the zero above is the warm-up's.
  await media('?w=160');
  expect(asked).toBe(1);
});
