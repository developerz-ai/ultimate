// The app's brand `<style>` (`DocumentOptions.brandHead`) is in the `<head>` of every document the
// page pipeline renders, in every render mode, AFTER the surface stylesheet it has to beat — and a
// document rendered with no brand carries no `<style>` at all.

import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { RenderMode } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet } from '@ultimat3/render/server';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import { appRoutes } from './runtime-render';

const BUILD_ID = 'build-under-test';
const BRAND = brandStyleTag(defineTheme({ preset: 'scifi' }));
const MODES: readonly RenderMode[] = ['ssr', 'static', 'stream', 'isr'];

const register = (render: RenderMode): void => {
  const surface = render === 'stream' ? 'app' : 'site';
  loadStylesheet(`/srv/demo/apps/web/${surface}/${render}/page.module.scss`, '.x{color:red}');
  registerRoute<{ url: string; params: Record<string, string> }>({
    file: `apps/web/${surface}/${render}/page.tsx`,
    suspenseBoundaries: render === 'stream' ? 1 : 0,
    config: defineRoute<{ url: string; params: Record<string, string> }>({
      render,
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      ...(render === 'isr' ? { revalidate: { ttl: '5m' } } : {}),
      meta: () => ({ title: render, description: 'a page that carries the app brand' }),
    }),
  });
};

const documentOf = async (render: RenderMode, brandHead?: string): Promise<string> => {
  const server = createServer({
    routes: appRoutes({ buildId: BUILD_ID, ...(brandHead === undefined ? {} : { brandHead }) }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const response = await server.fetch(new Request(`http://dev.test/${render}`));
  expect(response.status).toBe(200);
  return response.text();
};

afterEach(() => {
  clearRoutes();
  clearStylesheets();
});

describe('unit · the brand rides every document head', () => {
  for (const render of MODES) {
    test(`${render}: in <head>, once, after the surface stylesheet`, async () => {
      register(render);
      const head = (await documentOf(render, BRAND)).split('</head>')[0] ?? '';
      expect(head.split(BRAND).length - 1).toBe(1);
      // Sliced, not `indexOf`-compared: a missing link would answer -1 and pass an ordering check.
      const [beforeBrand = ''] = head.split(BRAND);
      expect(beforeBrand).toContain('<link rel="stylesheet"');
    });

    test(`${render}: no brand, no <style> — an unthemed app pays nothing`, async () => {
      register(render);
      expect(await documentOf(render)).not.toContain('<style');
    });
  }
});
