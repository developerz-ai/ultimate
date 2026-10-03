// A tag-only ISR page goes stale when its tag is busted. `appRoutes` builds the page routes for
// both boots; a controller nobody attached never hears `invalidateTags`, so a `revalidate: { tags }`
// page (no TTL) served its first render for the life of the process (plan 101, `s2-con #1`).

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateGraph, tag } from '@ultimat3/cache';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { createIsrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'isr-under-test';
const postTag = tag('post');
let version = 1;

function registerTagOnlyPage(): void {
  registerRoute({
    file: 'apps/web/site/blog/page.tsx',
    component: () => h('p', {}, `version ${version}`),
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [postTag] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Blog', description: 'a tag-only isr page' }),
    }),
  });
}

const restoreGraph = isolateGraph();

afterEach(() => {
  clearRoutes();
  version = 1;
});

afterAll(() => {
  // The revalidator slot is process-global: hand it back empty, through the same detach.
  createIsrController().attach()();
  restoreGraph();
});

const serverOver = (routes: ReturnType<typeof appRoutes>) =>
  createServer({
    routes,
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });

/** Render v1, bump the source to v2, bust the tag; answer what the next two requests served. */
async function bustCycle(routes: ReturnType<typeof appRoutes>): Promise<readonly string[]> {
  const server = serverOver(routes);
  const get = () => server.fetch(new Request('http://dev.test/blog'));
  const first = await get();
  expect(await first.text()).toContain('version 1');
  version = 2;
  await invalidateTags([postTag]);
  const second = await get();
  const secondBody = await second.text();
  // The stale copy is answered while the regeneration runs behind it; let it land.
  await Bun.sleep(0);
  const third = await (await get()).text();
  return [second.headers.get('x-ultimate-isr') ?? 'fresh', secondBody, third];
}

describe('unit · a tag bust reaches the ISR page', () => {
  test('appRoutes with no controller of its own attaches the one it builds', async () => {
    registerTagOnlyPage();
    const [state, stale, fresh] = await bustCycle(appRoutes({ buildId: BUILD_ID }));
    expect(state).toBe('stale');
    expect(stale).toContain('version 1');
    expect(fresh).toContain('version 2');
  });

  test('attachedIsr is the boots’ controller: attached, and released by its own detach', async () => {
    registerTagOnlyPage();
    const { isr, release } = attachedIsr({ buildId: BUILD_ID });
    const [state, , fresh] = await bustCycle(appRoutes({ buildId: BUILD_ID, isr }));
    expect(state).toBe('stale');
    expect(fresh).toContain('version 2');

    release();
    version = 3;
    await invalidateTags([postTag]);
    // Released: the bust no longer reaches this controller's store.
    expect(
      isr
        .store()
        .paths()
        .every((path) => isr.store().get(path)?.stale === false),
    ).toBe(true);
  });
});
