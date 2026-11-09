// `attachedIsr`'s own contract, beside the pipeline suites that use it: the controller it hands
// back hears `invalidateTags`, and its `release` is idempotent. A boot's stop list and `x dev`'s
// reload can both call one release, and a second call must never detach the controller that
// attached after it — that would leave the live process's tag-only pages fresh for ever.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { invalidateTags, isolateGraph, tag } from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { clearRoutes, defineRoute, h, registerRoute } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { attachedIsr } from './runtime-isr';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'attached-isr-under-test';
const postTag = tag('post');

const restoreGraph = isolateGraph();

afterEach(() => clearRoutes());

afterAll(() => {
  // The revalidator slot is process-global: hand it back empty, through the same detach.
  isrController().attach()();
  restoreGraph();
});

function registerTagOnlyPage(): void {
  registerRoute({
    file: 'apps/web/site/news/page.tsx',
    component: () => h('p', {}, 'news'),
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [postTag] },
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'News', description: 'a tag-only isr page' }),
    }),
  });
}

/** Render the page once through `isr`, bust its tag, and answer whether the stored copy went stale. */
async function staleAfterBust(isr: ReturnType<typeof attachedIsr>['isr']): Promise<boolean> {
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, isr }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  expect((await server.fetch(new Request('http://dev.test/news'))).status).toBe(200);
  const paths = await isr.store().paths();
  // Stored, or the verdict below would be read over an empty store.
  expect(paths.length).toBeGreaterThan(0);
  await invalidateTags([postTag]);
  const entries = await Promise.all(paths.map((path) => isr.store().get(path)));
  return entries.every((entry) => entry?.stale === true);
}

describe('unit · attachedIsr', () => {
  test('the controller it returns hears a tag bust', async () => {
    registerTagOnlyPage();
    const attached = attachedIsr({ buildId: BUILD_ID });
    try {
      expect(await staleAfterBust(attached.isr)).toBe(true);
    } finally {
      attached.release();
    }
  });

  test('a second release of an old controller leaves the one attached after it attached', async () => {
    registerTagOnlyPage();
    const old = attachedIsr({ buildId: BUILD_ID });
    old.release();
    const current = attachedIsr({ buildId: BUILD_ID });
    try {
      old.release();
      expect(await staleAfterBust(current.isr)).toBe(true);
    } finally {
      current.release();
    }
  });
});
