// `x dev`'s rebuild empties the ISR store so a save is served at once — and a render that began
// with the OLD module before the save, landing after the clear, must not be written back as fresh
// (audit round 2: a tag-only page served the pre-save HTML until a tag bust).

import { afterAll, beforeEach, expect, test } from 'bun:test';
import { isolateGraph, resetGraph, tag } from '@ultimat3/cache';
import type { RouteMetaFn } from '@ultimat3/render';
import { clearRoutes, defineRoute, describePages, registerRoute } from '@ultimat3/render';
import { isrController } from '@ultimat3/render/server';
import { clearIsrForRebuild } from './dev-rebuild-isr';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const restore = isolateGraph();
beforeEach(() => {
  clearRoutes();
  resetGraph();
});
afterAll(() => {
  clearRoutes();
  restore();
});

test('a render begun before the save never lands as a fresh page after the rebuild clear', async () => {
  registerRoute({
    file: 'apps/web/site/pricing/page.tsx',
    config: defineRoute({
      render: 'isr',
      revalidate: { tags: [tag('post')] },
      offline: 'precache',
      hydrate: 'never',
      meta,
    }),
  });
  const isr = isrController({ routes: describePages });
  await isr.regenerate('/pricing', async () => 'v1');
  // T0: a request re-renders with the OLD module.
  let finish!: (html: string) => void;
  const inflight = isr.regenerate(
    '/pricing',
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  // T1: the save's rebuild clears the store.
  await clearIsrForRebuild(isr.store());
  expect(await isr.store().paths()).toEqual([]);
  // T2: the old render resolves.
  finish('v1-old-module');
  await inflight;
  const held = await isr.store().get('/pricing');
  expect(held === undefined || held.stale === true).toBe(true);
});
