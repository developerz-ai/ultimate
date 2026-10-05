// `x dev`'s route table must serve what the container serves. The container hands `/media` the
// app's `runtime.ts` image driver (`serve-web.ts`); a dev table that dropped it answered every
// variant from the builtin pipeline, so a CDN-backed transform was only ever seen in production.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { createRaster, encodeImage, userActor } from '@ultimat3/core';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { clearPermissions, clearRoles, definePermissions, defineRoles } from '@ultimat3/policy';
import type { ImageTransformDriver } from '@ultimat3/seo';
import { defineStorage, localDriver, resetStorage } from '@ultimat3/storage';
import type { DevDashboardInput } from './dev-dashboard';
import { devRouteTable } from './dev-route-table';
import { islandBundle } from './island-bundle';
import { MEDIA_BASE_PATH } from './runtime-assets';
import { STORAGE_READ_PERMISSION } from './runtime-storage';

const SOURCE_KEY = 'covers/hero.png';
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'x-dev-route-table-'));
  await Bun.write(join(root, 'app.config.ts'), 'export const config = { name: "fixture" };\n');
  definePermissions([STORAGE_READ_PERMISSION]);
  defineRoles({ member: { grants: [STORAGE_READ_PERMISSION] } });
});

afterEach(async () => {
  clearPermissions();
  clearRoles();
  resetStorage();
  await rm(root, { recursive: true, force: true });
});

describe('unit · x dev route table', () => {
  test("the app's runtime images driver reaches /media", async () => {
    const storage = defineStorage({ disks: { local: localDriver({ root: join(root, '.s') }) } });
    await storage.disk().put(SOURCE_KEY, encodeImage(createRaster(64, 32, 'fixture'), 'png'), {
      contentType: 'image/png',
    });
    const asked: string[] = [];
    const images: ImageTransformDriver = {
      name: 'fixture-cdn',
      transform: async (request) => {
        asked.push(`${request.src}@${request.width}`);
        return {
          bytes: new TextEncoder().encode('from the app driver'),
          contentType: 'image/webp',
          width: request.width,
          height: request.width,
        };
      },
      blurPlaceholder: async () => '',
    };
    const { routes } = await devRouteTable({
      root,
      env: {},
      buildId: 'dev-route-table',
      storage,
      // Only its routes are built here; nothing below asks the dashboard a question, so its
      // services are inert stand-ins (a non-memory mail driver, a database never queried).
      dashboard: {
        root,
        runtime: { mail: { name: 'unused' }, db: {} },
        status: () => ({}),
      } as unknown as DevDashboardInput,
      islands: () => islandBundle([]),
      realtime: { enabled: false },
      images,
    });
    const media = routes.find((route) => route.path === `${MEDIA_BASE_PATH}/*key`);
    expect(media).toBeDefined();
    if (media === undefined) return;
    const url = new URL(`http://dev.test${MEDIA_BASE_PATH}/${SOURCE_KEY}?w=16`);
    const ctx = createRequestContext({
      url,
      method: 'GET',
      role: 'web',
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    ctx.params = { key: SOURCE_KEY };
    ctx.actor = userActor({ id: 'u-1', roles: ['member'], orgId: 'org-1' });
    const response = await media.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('from the app driver');
    expect(asked).toEqual([`${SOURCE_KEY}@16`]);
  });
});
