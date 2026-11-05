// A `useQuery` island is held off screen (#506) only where the boot can restore a record it reads:
// a real island build of one fixture app, asked against the entity registry the boot loaded, then
// the served document. No `persist: true` entity, no `data-x-hold`; one, and the island is held.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no recursive delete; `rm(…, { force: true })` removes a root that may not exist.
import { rm } from 'node:fs/promises';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { userActor } from '@ultimat3/core';
import { clearRegistry, type RegistryEntry, registerEntity } from '@ultimat3/entity';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import {
  clearRoutes,
  defineRoute,
  ISLAND_HOLD_ATTRIBUTE,
  island,
  registerRoute,
} from '@ultimat3/render';
import { buildIslands } from '../src/island-bundle';
import { processRoot } from '../src/process-root-fixture';
import { appRoutes } from '../src/runtime-render';

const ROOT = processRoot(join(import.meta.dir, '..', '.island-fixture', 'no-persist'));
const FILE = 'apps/web/app/feed/rows.island.tsx';
const BUILD_ID = 'build-under-test';
const ALICE = userActor({ id: 'alice@example.com', permissions: ['feed.read'] });
const Rows = island({ src: './rows.island.tsx' });

/** The registry entry an `entity()` declaration registers, reduced to what the probe reads. */
const entry = (name: string, persist: boolean): RegistryEntry => ({
  name,
  tableName: name,
  persist,
  describe: () => expect.unreachable('the island build describes no entity'),
  references: () => [],
});

/** The served `/feed`, with this registry's island build behind it. */
async function feed(): Promise<string> {
  const bundle = await buildIslands(ROOT, { only: FILE });
  expect(bundle.realtime.has(FILE)).toBe(true);
  registerRoute({
    file: 'apps/web/app/feed/page.tsx',
    config: defineRoute({
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'interaction',
      budget: { js: '500kb' },
      meta: () => ({ title: 'feed', description: 'hold under test' }),
      policy: { permission: 'feed.read' },
    }),
    component: (() => Rows({ children: 'rows' })) as never,
  });
  const server = httpServer({
    routes: appRoutes({
      buildId: BUILD_ID,
      sync: { syncUrl: '/_x/sync', buildId: BUILD_ID, bootUrl: '/_x/page-boot/abcd1234.js' },
      resolveIsland: (routeFile) => bundle.resolverFor(routeFile),
      realtimeIslands: () => bundle.realtime,
    }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => ALICE, authorize: () => ({ allowed: true }) },
  });
  const response = await server.fetch(new Request('http://dev.test/feed'));
  expect(response.status).toBe(200);
  return response.text();
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(join(ROOT, 'package.json'), JSON.stringify({ name: 'no-persist-fixture' }));
  await Bun.write(
    join(ROOT, FILE),
    "import { useQuery } from '@ultimat3/realtime';\nexport const mount = useQuery;\n",
  );
});

afterEach(() => {
  clearRegistry();
  clearRoutes();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('e2e · a useQuery island is held only in an app that persists a record', () => {
  test('no entity declared persist: the served island carries no hold', async () => {
    registerEntity(entry('note', false));
    const html = await feed();
    expect(html).toContain('data-x-entry="/islands/');
    expect(html).not.toContain(ISLAND_HOLD_ATTRIBUTE);
  });

  test('one entity declared persist: the same island is held, as the reference app is', async () => {
    registerEntity(entry('note', false));
    registerEntity(entry('post', true));
    expect(await feed()).toContain(ISLAND_HOLD_ATTRIBUTE);
  });
});
