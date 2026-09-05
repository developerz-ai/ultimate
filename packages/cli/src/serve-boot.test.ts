// The container's boot, IN this process: `serveApp` over the embedded database, the same
// `startRoles` a `ROLE=web` container runs. `serve.live.test.ts` proves the spawned entry point;
// this proves the composition a coverage run can see — `bootRoles`, the app's MCP mount on the
// container path, and the `apps/<app>/runtime.ts` read — without a child process between.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture is joined to this file's directory.
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { isolateDeclaredTags, resetTiers } from '@ultimat3/cache';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';
import type { ServedApp } from './serve';
import { serveApp } from './serve';

const ROOT = join(import.meta.dir, '..', '.serve-boot-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'serve-boot-fixture', version: '1.0.0' }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'serve-boot-fixture' });
`,
  // The container path mounts the app's MCP endpoint through the same call `x dev` makes.
  'apps/web/mcp.ts': `import { defineAppMcp } from '@ultimat3/mcp';
export const mcp = defineAppMcp({ include: 'exposed', resolveToken: () => null });
`,
  // Read by `withAppRuntime` because this boot passes no `runtime` — the scaffolded server's case.
  'apps/web/runtime.ts': `export const runtime = { middleware: [async (_ctx, next) => next()] };
`,
};

/** Booting embedded Postgres and the HTTP role is seconds of real work on a loaded machine. */
const BOOT_TIMEOUT_MS = 60_000;

const resetRegistries = (): void => {
  resetActions();
  resetQueries();
  clearEntities();
  clearRoutes();
  resetJobs();
  resetTasks();
  clearPermissions();
  clearRoles();
  resetAppLoad();
};

const restoreTags = isolateDeclaredTags();

let app: ServedApp | undefined;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  resetRegistries();
  app = await serveApp({ root: ROOT, env: {}, role: 'web', port: 0, metricsPort: 0 });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await app?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    resetTiers();
    resetRegistries();
    restoreTags();
  }
}, BOOT_TIMEOUT_MS);

describe('serveApp, the container boot in this process', () => {
  // `/healthz` and `/readyz` sit in Bun's native `routes` table, which `handle.fetch` bypasses by
  // design — `serve.live.test.ts` measures them over a real socket. What the in-process handle
  // proves is the pipeline itself: an unknown path answers the framework's own problem document.
  test('binds the web role, and the pipeline answers an unknown path as problem+json', async () => {
    if (app === undefined || app.url === null) expect.unreachable('the web role did not boot');
    expect(app.role).toBe('web');
    expect(app.url.startsWith('http://')).toBe(true);
    const handle = app.running.server;
    if (handle === null) expect.unreachable('no server handle');
    const missing = await handle.fetch(new Request(`${app.url}/nowhere`));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code?: string }).code).toBe('X_ROUTE_NOT_FOUND');
  });

  test("mounts the app's MCP endpoint — 401 is the route's own verdict, never 404", async () => {
    const handle = app?.running.server ?? null;
    if (app === undefined || handle === null) expect.unreachable('no server handle');
    const response = await handle.fetch(new Request(`${app.url}/mcp`, { method: 'POST' }));
    expect(response.status).not.toBe(404);
  });

  test('a web-only boot has no sync node, so it has no live feed', () => {
    expect(app?.running.liveFeed).toBe('none');
    expect(app?.running.liveRegistry).toBeNull();
  });
});
