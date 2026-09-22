// The page's ONE sync worker bundle, against a real `Bun.build` and the real route: built from a
// fixture entry (the shape `@ultimat3/realtime/sync-worker` has), served immutable at a
// source-addressed URL, and absent — not an error — for an app with no realtime.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import {
  buildPageBoot,
  buildSyncWorker,
  PAGE_BOOT_BASE_PATH,
  pageBootRoutes,
  SYNC_WORKER_BASE_PATH,
  syncWorkerRoutes,
} from './worker-bundle';

const ROOT = join(import.meta.dir, '..', '.island-fixture', 'worker');
const ENTRY = join(ROOT, 'sync-worker.ts');
const WORKER = `const scope = self as unknown as { onconnect: ((event: MessageEvent) => void) | null };
scope.onconnect = (event) => { event.ports[0]?.postMessage('ready'); };
`;

beforeEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'worker-fixture' }));
  await Bun.write(ENTRY, WORKER);
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('buildSyncWorker', () => {
  test('one classic-script bundle at a source-addressed URL under the worker base', async () => {
    const worker = await buildSyncWorker(ROOT, { entry: ENTRY });

    expect(worker?.url).toMatch(new RegExp(`^${SYNC_WORKER_BASE_PATH}/[0-9a-f]{8}\\.js$`));
    // A classic script, never ESM: `new SharedWorker(url)` with no `{ type: 'module' }` must run it.
    expect(worker?.code).not.toMatch(/^\s*(import|export)\b/m);
    expect(worker?.code).toContain('onconnect');
  });

  test('the same source keeps its URL, an edited one moves it', async () => {
    const first = await buildSyncWorker(ROOT, { entry: ENTRY });
    expect((await buildSyncWorker(ROOT, { entry: ENTRY }))?.url).toBe(first?.url ?? '');

    await Bun.write(ENTRY, `${WORKER}// protocol 2\nconsole.info('v2');\n`);
    expect((await buildSyncWorker(ROOT, { entry: ENTRY }))?.url).not.toBe(first?.url ?? '');
  });

  test('an app that cannot resolve @ultimat3/realtime has no worker, and says so by absence', async () => {
    // OUTSIDE the checkout: anywhere under it, module resolution walks up to a `node_modules` that
    // has realtime installed.
    const lone = join(Bun.env['TMPDIR'] ?? '/tmp', `ultimate-no-realtime-${crypto.randomUUID()}`);
    await Bun.write(join(lone, 'package.json'), JSON.stringify({ name: 'no-realtime' }));
    try {
      expect(await buildSyncWorker(lone)).toBeUndefined();
    } finally {
      await rm(lone, { recursive: true, force: true });
    }
  });

  test('an entry that will not compile is X_BUILD_FAILED naming the entry', async () => {
    await Bun.write(ENTRY, 'export const = ;\n');
    const error = await buildSyncWorker(ROOT, { entry: ENTRY }).catch((caught: unknown) => caught);

    expect(error).toBeUltimateError('X_BUILD_FAILED');
    expect(error instanceof Error && 'cause' in error ? String(error.cause) : '').toContain(
      'the sync worker',
    );
  });
});

describe('syncWorkerRoutes', () => {
  const serve = (worker: Awaited<ReturnType<typeof buildSyncWorker>>) =>
    createServer({
      routes: syncWorkerRoutes(() => worker),
      role: 'web',
      config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
    });

  test('serves the bundle immutable, as JavaScript, at the URL the page is told', async () => {
    const worker = await buildSyncWorker(ROOT, { entry: ENTRY });
    const response = await serve(worker).fetch(new Request(`http://dev.test${worker?.url ?? ''}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe(worker?.code ?? '');
  });

  test('a URL from another build is a 404 naming why, never another build’s worker', async () => {
    const worker = await buildSyncWorker(ROOT, { entry: ENTRY });
    const response = await serve(worker).fetch(
      new Request(`http://dev.test${SYNC_WORKER_BASE_PATH}/00000000.js`),
    );

    expect(response.status).toBe(404);
  });
});

describe('the page boot', () => {
  test("is realtime's real `./boot`, one classic script, served immutable at its own URL", async () => {
    // The checkout's own realtime: the boot an app built from this tree ships.
    const boot = await buildPageBoot(join(import.meta.dir, '..', '..', 'realtime'));
    expect(boot?.url).toMatch(new RegExp(`^${PAGE_BOOT_BASE_PATH}/[0-9a-f]{8}\\.js$`));
    expect(boot?.code).not.toMatch(/^\s*(import|export)\b/m);
    // It opens the outbox with the page: the one guarantee a read-only page relies on it for.
    expect(boot?.code).toContain('ultimate.outbox');

    const server = createServer({
      routes: pageBootRoutes(() => boot),
      role: 'web',
      config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
    });
    const response = await server.fetch(new Request(`http://dev.test${boot?.url ?? ''}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe(boot?.code ?? '');

    const stale = await server.fetch(new Request(`http://dev.test${PAGE_BOOT_BASE_PATH}/0000.js`));
    expect(stale.status).toBe(404);
  });
});

describe('a workspace app, whose realtime is a dependency of apps/<app> and not of the root', () => {
  test('the scripts are resolved from the app that has realtime — as its islands resolve it', async () => {
    // OUTSIDE the checkout, so nothing walks up to the repo's own install.
    const app = join(Bun.env['TMPDIR'] ?? '/tmp', `ultimate-workspace-${crypto.randomUUID()}`);
    const realtime = join(app, 'apps/web/node_modules/@ultimat3/realtime');
    await Bun.write(join(app, 'package.json'), JSON.stringify({ name: 'workspace-root' }));
    await Bun.write(join(app, 'apps/web/package.json'), JSON.stringify({ name: 'web' }));
    await Bun.write(
      join(realtime, 'package.json'),
      JSON.stringify({
        name: '@ultimat3/realtime',
        exports: { './boot': './boot.ts', './sync-worker': './worker.ts' },
      }),
    );
    await Bun.write(join(realtime, 'boot.ts'), "console.info('boot');\n");
    await Bun.write(join(realtime, 'worker.ts'), "console.info('worker');\n");
    try {
      expect((await buildPageBoot(app))?.code).toContain('boot');
      expect((await buildSyncWorker(app))?.code).toContain('worker');
    } finally {
      await rm(app, { recursive: true, force: true });
    }
  });
});
