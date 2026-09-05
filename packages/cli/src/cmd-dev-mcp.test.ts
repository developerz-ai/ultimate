// `x dev` mounts the app's own MCP endpoint. `POST /mcp` answered X_ROUTE_NOT_FOUND in every
// process the framework booted until 2026-09-05: `defineAppMcp` built the route and no boot mounted
// it. Its own boot and its own fixture, because `cmd-dev.test.ts` sits at the line ceiling.
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
import type { DevServer } from './cmd-dev';
import { startDev } from './cmd-dev';

const ROOT = join(import.meta.dir, '..', '.dev-mcp-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-mcp-fixture', version: '1.0.0' }),
  // The root marker a real `x dev` cannot start without, and where `ai.mcp` is declared — by
  // default `{ expose: true, path: '/mcp' }`, which is what the mount reads.
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'dev-mcp-fixture' });
`,
  // `resolveToken` answering `null` rejects every bearer: enough to prove the ROUTE is mounted.
  'apps/web/mcp.ts': `import { defineAppMcp } from '@ultimat3/mcp';
export const mcp = defineAppMcp({ include: 'exposed', resolveToken: () => null });
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

let server: DevServer | undefined;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) await Bun.write(join(ROOT, path), contents);
  resetRegistries();
  server = await startDev({ root: ROOT, port: 0, env: {}, roles: ['web'] });
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  try {
    await server?.stop();
    await rm(ROOT, { recursive: true, force: true });
  } finally {
    // The tiers `startDev` registers are the ones `stop()` releases; a boot that never finished
    // has nothing to stop, and the leak guard names exactly those two tiers otherwise.
    resetTiers();
    resetRegistries();
    restoreTags();
  }
}, BOOT_TIMEOUT_MS);

describe("x dev mounts the app's MCP endpoint", () => {
  test('POST /mcp reaches the route — 401 is its own verdict on a missing bearer, never 404', async () => {
    const handle = server?.running.server ?? null;
    if (handle === null) expect.unreachable('the web role did not boot');
    const response = await handle.fetch(new Request('http://dev.test/mcp', { method: 'POST' }));
    expect(response.status).not.toBe(404);
  });

  test('the boot report names the mount', () => {
    expect(server?.mcp).toBe('/mcp');
  });
});
