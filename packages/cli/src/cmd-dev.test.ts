// `x dev` end to end, against a real app on disk: PGlite boots, the jobs table is created, the
// app's modules register, and the actions those modules declared answer over the same HTTP
// pipeline production runs. A fixture that stubbed any of that would prove nothing — the bug this
// replaces was a dev server that served `/_x` and 404'd every route the app actually had.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resetRegistry as resetActions } from '@ultimat3/action';
import { clearRegistry as clearEntities } from '@ultimat3/entity';
import { resetJobs, resetTasks } from '@ultimat3/jobs';
import { clearPermissions, clearRoles } from '@ultimat3/policy';
import { resetRegistry as resetQueries } from '@ultimat3/query';
import { clearRoutes } from '@ultimat3/render';
import { resetAppLoad } from './app-load';
import type { DevServer } from './cmd-dev';
import { devCommand, startDev } from './cmd-dev';

// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve through the same tsconfig
// paths the framework's own sources use; a dot-prefixed name keeps it out of every workspace glob.
const ROOT = join(import.meta.dir, '..', '.dev-fixture');

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'dev-fixture', version: '1.4.0' }),

  'apps/web/app/posts/policy.ts': `import { allow, can, definePermissions } from '@ultimat3/policy';
export const permissions = definePermissions(['post:publish'] as const);
export const canPostWrite = can('post:publish');
export const anyone = allow();
`,

  'apps/web/app/posts/actions.ts': `import { action, t } from '@ultimat3/action';
import { anyone, canPostWrite } from './policy';

export const publishPost = action({
  input: t.object({ id: t.uuid }),
  output: t.object({ id: t.uuid }),
  policy: canPostWrite,
  async handle({ input }) {
    return { id: input.id };
  },
});

export const echoPost = action({
  input: t.object({ word: t.string }),
  output: t.object({ word: t.string }),
  policy: anyone,
  async handle({ input }) {
    return { word: input.word };
  },
});
`,

  'apps/web/site/pricing.tsx': `import { defineRoute } from '@ultimat3/render';

export const config = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  budget: { js: '0kb' },
  meta: () => ({ title: 'Pricing', description: 'What it costs' }),
});
`,
};

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

let server: DevServer;

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  for (const [path, contents] of Object.entries(FILES)) {
    await Bun.write(join(ROOT, path), contents);
  }
  resetRegistries();
  // Port 0 asks the OS for a free one, so this suite never collides with a running `x dev`.
  server = await startDev({ root: ROOT, port: 0, env: {}, roles: ['web', 'worker', 'scheduler'] });
});

afterAll(async () => {
  await server?.stop();
  await rm(ROOT, { recursive: true, force: true });
  resetRegistries();
});

const fetchDev = (path: string, init?: RequestInit): Promise<Response> => {
  const handle = server.running.server;
  if (handle === null) throw new Error('the web role did not start');
  return handle.fetch(new Request(`http://dev.test${path}`, init));
};

describe('unit · x dev boots the app', () => {
  test('every selected role is running, and the unselected ones are not', () => {
    expect(server.roles).toEqual(['web', 'worker', 'scheduler']);
    expect(server.running.worker).not.toBeNull();
    expect(server.running.scheduler).not.toBeNull();
    expect(server.running.syncUrl).toBeNull();
    expect(server.findings).toEqual([]);
  });

  test('the app loaded cleanly and its actions are mounted as HTTP routes', async () => {
    const response = await fetchDev('/api/posts/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word: 'hi' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ word: 'hi' });
  });

  test("an action's policy is enforced by the pipeline, not skipped in dev", async () => {
    const response = await fetchDev('/api/posts/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000000' }),
    });
    expect(response.status).toBe(401);
  });

  test('a page route registered by the app renders its own head', async () => {
    const response = await fetchDev('/pricing');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Pricing</title>');
  });

  test('/_x still answers, and reports the roles and services it booted', async () => {
    expect(await (await fetchDev('/_x')).json()).toMatchObject({ ok: true });
    const services = (await (await fetchDev('/_x/services')).json()) as {
      roles: string[];
      services: { db: { mode: string } };
      reloads: number;
    };
    expect(services.roles).toEqual(['web', 'worker', 'scheduler']);
    expect(services.services.db.mode).toBe('embedded');
    expect(services.reloads).toBe(0);
  });

  test('/_x/manifest is the loaded app, not a second scan of the source', async () => {
    const manifest = (await (await fetchDev('/_x/manifest')).json()) as {
      app: { name: string; version: string };
      actions: { name: string }[];
      routes: { url: string }[];
    };
    expect(manifest.app).toEqual({ name: 'dev-fixture', version: '1.4.0' });
    expect(manifest.actions.map((action) => action.name).sort()).toEqual([
      'echoPost',
      'publishPost',
    ]);
    expect(manifest.routes.map((route) => route.url)).toEqual(['/pricing']);
  });

  test('the embedded database is real Postgres — the jobs table exists in it', async () => {
    const rows = await server.runtime.db.query<{ table_name: string }>({
      text: "select table_name from information_schema.tables where table_name = 'x_jobs'",
      values: [],
    });
    expect(rows).toHaveLength(1);
  });

  test('--role is a declared flag with the dev roles in its summary', () => {
    const role = devCommand.spec.flags?.find((flag) => flag.name === 'role');
    expect(role?.summary).toContain('web,sync,worker,scheduler');
  });
});
