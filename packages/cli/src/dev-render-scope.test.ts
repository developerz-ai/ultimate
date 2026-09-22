// The client head in the document `x dev` serves: an opaque per-principal id in
// `<meta name="ultimate-scope">` on a PRIVATE document only — a document a shared cache may hold
// carries none — and the principal-free sync target on every document.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { clientScopeOf } from '@ultimat3/auth';
import type { Actor } from '@ultimat3/core';
import {
  CLIENT_BUILD_META,
  CLIENT_PERSIST_META,
  CLIENT_SCOPE_META,
  CLIENT_SYNC_META,
  CLIENT_SYNC_WORKER_META,
  userActor,
} from '@ultimat3/core';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, island, registerRoute } from '@ultimat3/render';
import { appRoutes } from './dev-render';
import { reachesRealtime } from './island-realtime';

const BUILD_ID = 'build-under-test';
const ALICE = userActor({ id: 'alice@example.com', permissions: ['settings.read'] });
const SCOPE_META = new RegExp(`<meta name="${CLIENT_SCOPE_META}" content="([^"]*)">`);

function register(file: string, render: RenderMode, gated: boolean): void {
  registerRoute({
    file,
    suspenseBoundaries: render === 'stream' ? 1 : 0,
    config: defineRoute({
      render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: file, description: 'scope under test' }),
      ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
      ...(gated ? { policy: { permission: 'settings.read' } } : {}),
    }),
  });
}

async function scopeIn(path: string, actor: Actor | null): Promise<string | null> {
  const server = createServer({
    routes: appRoutes({ buildId: BUILD_ID }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor, authorize: () => ({ allowed: true }) },
  });
  const response = await server.fetch(new Request(`http://dev.test${path}`));
  expect(response.status).toBe(200);
  return SCOPE_META.exec(await response.text())?.[1] ?? null;
}

afterEach(() => {
  clearRoutes();
});

describe('unit · the client scope a document carries', () => {
  test('a gated ssr page carries the signed-in principal, opaquely', async () => {
    register('apps/web/app/settings/page.tsx', 'ssr', true);
    const scope = await scopeIn('/settings', ALICE);

    expect(scope).toBe(clientScopeOf(ALICE));
    expect(scope).not.toContain('alice');
  });

  test('a stream is private, so it carries the scope — empty for the anonymous page', async () => {
    register('apps/web/app/feed/page.tsx', 'stream', false);

    expect(await scopeIn('/feed', ALICE)).toBe(clientScopeOf(ALICE));
    expect(await scopeIn('/feed', null)).toBe('');
  });

  test('a shareable document carries NO scope tag at all, whoever asked', async () => {
    register('apps/web/site/page.tsx', 'static', false);
    register('apps/web/site/pricing/page.tsx', 'isr', false);
    register('apps/web/site/blog/page.tsx', 'ssr', false);

    for (const path of ['/', '/pricing', '/blog']) expect(await scopeIn(path, ALICE)).toBeNull();
  });
});

describe('unit · the sync target every document carries', () => {
  test('principal-free, so even a shareable static page names the socket, the build and the worker', async () => {
    register('apps/web/site/page.tsx', 'static', false);
    const server = createServer({
      routes: appRoutes({
        buildId: BUILD_ID,
        sync: { syncUrl: '/_x/sync', buildId: BUILD_ID, workerUrl: '/_x/sync-worker/0a1b2c3d.js' },
      }),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => ALICE },
    });
    const html = await (await server.fetch(new Request('http://dev.test/'))).text();

    expect(html).toContain(`<meta name="${CLIENT_SYNC_META}" content="/_x/sync">`);
    expect(html).toContain(`<meta name="${CLIENT_BUILD_META}" content="${BUILD_ID}">`);
    expect(html).toContain(
      `<meta name="${CLIENT_SYNC_WORKER_META}" content="/_x/sync-worker/0a1b2c3d.js">`,
    );
    expect(html).not.toContain(CLIENT_SCOPE_META);
  });
});

describe('unit · the persisted record types ride with the scope', () => {
  const serveWith = (actor: Actor | null) =>
    createServer({
      routes: appRoutes({ buildId: BUILD_ID, persisted: () => ['post', 'comment'] }),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => actor, authorize: () => ({ allowed: true }) },
    });
  const persistIn = async (path: string, actor: Actor | null): Promise<string | null> => {
    const html = await (await serveWith(actor).fetch(new Request(`http://dev.test${path}`))).text();
    return (
      new RegExp(`<meta name="${CLIENT_PERSIST_META}" content="([^"]*)">`).exec(html)?.[1] ?? null
    );
  };

  test('a private document names every persisted type', async () => {
    register('apps/web/app/settings/page.tsx', 'ssr', true);
    expect(await persistIn('/settings', ALICE)).toBe('comment,post');
  });

  test('a shareable document names none — there is no principal to persist under', async () => {
    register('apps/web/site/page.tsx', 'static', false);
    register('apps/web/site/blog/page.tsx', 'ssr', false);
    for (const path of ['/', '/blog']) expect(await persistIn(path, ALICE)).toBeNull();
  });
});

describe('unit · the page boot rides with the scope AND a realtime island', () => {
  const BOOT = '/_x/page-boot/abcd1234.js';
  const ROOT = join(import.meta.dir, '..', '.boot-fixture');
  const Live = island({ src: './live.island.tsx' });
  const Plain = island({ src: './plain.island.tsx' });

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'apps/web/app/settings/live.island.tsx'),
      "import { useRecord } from '@ultimat3/realtime';\nexport const mount = useRecord;\n",
    );
    await Bun.write(
      join(ROOT, 'apps/web/app/settings/plain.island.tsx'),
      'export function mount(): void {}\n',
    );
    // What every island build asks, and what the renderer then reads back.
    expect(await reachesRealtime(ROOT, 'apps/web/app/settings/live.island.tsx')).toBe(true);
    expect(await reachesRealtime(ROOT, 'apps/web/app/settings/plain.island.tsx')).toBe(false);
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  const page = (render: RenderMode, gated: boolean, body: () => unknown): void => {
    registerRoute({
      file: 'apps/web/app/settings/page.tsx',
      // A stream must declare a boundary; the count is all the registry checks.
      suspenseBoundaries: render === 'stream' ? 1 : 0,
      config: defineRoute({
        render,
        offline: 'network-only',
        hydrate: 'interaction',
        budget: { js: '100kb' },
        meta: () => ({ title: 'settings', description: 'boot under test' }),
        ...(gated ? { policy: { permission: 'settings.read' } } : {}),
      }),
      component: body as never,
    });
  };

  const bootIn = async (actor: Actor | null): Promise<boolean> => {
    const server = createServer({
      routes: appRoutes({
        buildId: BUILD_ID,
        sync: { syncUrl: '/_x/sync', buildId: BUILD_ID, bootUrl: BOOT },
      }),
      role: 'web',
      config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => actor, authorize: () => ({ allowed: true }) },
    });
    const html = await (await server.fetch(new Request('http://dev.test/settings'))).text();
    const tags = html.split(`<script src="${BOOT}" defer></script>`).length - 1;
    expect(tags).toBeLessThanOrEqual(1);
    return tags === 1;
  };

  test('a private page rendering a realtime island carries ONE deferred boot script', async () => {
    page('ssr', true, () => Live({ children: 'x' }));
    expect(await bootIn(ALICE)).toBe(true);
  });

  test('a private page whose islands never reach realtime carries none — no 34.9 kB for nothing', async () => {
    page('ssr', true, () => Plain({ children: 'x' }));
    expect(await bootIn(ALICE)).toBe(false);
  });

  test('a stream is private: its realtime island earns the boot too, anonymous included', async () => {
    page('stream', false, () => Live({ children: 'x' }));
    expect(await bootIn(null)).toBe(true);
  });

  test('a shareable document carries none, whatever its islands — no principal to boot for', async () => {
    page('ssr', false, () => Live({ children: 'x' }));
    expect(await bootIn(ALICE)).toBe(false);
  });
});
