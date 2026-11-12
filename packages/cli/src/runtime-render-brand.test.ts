// The app's brand reaches every document the page pipeline renders, in every render mode, through
// the surface stylesheet it links — no inline `<style>`. The proof is the CASCADE: walking the head
// in document order, resolving each `<link>` to its bytes, yields the surface's rules then the
// brand's — exactly what the old `<link>` + inline `<style>` pair gave the browser.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { RenderMode, Surface } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets, loadStylesheet, stylesFor } from '@ultimat3/render/server';
import { defineTheme } from '@ultimat3/ui';
import { appRoutes } from './runtime-render';
import { setBrandStyles, styleBundle } from './style-bundle';
import { themeBoot } from './theme-boot';

const BUILD_ID = 'build-under-test';
const BRAND = defineTheme({ preset: 'scifi' }).css;
const MODES: readonly RenderMode[] = ['ssr', 'static', 'stream', 'isr'];
const surfaceOf = (render: RenderMode): Surface => (render === 'stream' ? 'app' : 'site');

const register = (render: RenderMode): void => {
  const surface = surfaceOf(render);
  loadStylesheet(`/srv/demo/apps/web/${surface}/${render}/page.module.scss`, '.x{color:red}');
  registerRoute<{ url: string; params: Record<string, string> }>({
    file: `apps/web/${surface}/${render}/page.tsx`,
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

const THEME = themeBoot('system');

const headOf = async (render: RenderMode): Promise<string> => {
  const server = httpServer({
    routes: appRoutes({ buildId: BUILD_ID, themeHead: THEME.head }),
    role: 'web',
    config: defineHttpConfig({ dev: true, buildId: BUILD_ID, rateLimit: { scope: 'process' } }),
  });
  const response = await server.fetch(new Request(`http://dev.test/${render}`));
  expect(response.status).toBe(200);
  return (await response.text()).split('</head>')[0] ?? '';
};

/** The style the browser applies, in order: a `<link>` read as its file, a `<style>` as is. */
const cascadeOf = (head: string): string => {
  const pattern = /<link rel="stylesheet" href="([^"]+)">|<style[^>]*>([\s\S]*?)<\/style>/g;
  return [...head.matchAll(pattern)]
    .map(([, href, inline]) =>
      href === undefined ? (inline ?? '') : (styleBundle().chunkAt(href)?.css ?? '<missing>'),
    )
    .join('\n');
};

afterEach(() => {
  clearRoutes();
  clearStylesheets();
  setBrandStyles('');
});

describe('unit · the brand rides every document, through its stylesheet', () => {
  for (const render of MODES) {
    test(`${render}: the cascade is the surface's rules, then the brand's — and no <style>`, async () => {
      register(render);
      setBrandStyles(BRAND);
      const head = await headOf(render);
      expect(head).not.toContain('<style');
      expect(cascadeOf(head)).toBe(`${stylesFor(surfaceOf(render))}\n${BRAND}`);
      // No flash: the no-flash theme script still runs before the render-blocking sheet.
      const [beforeSheet = ''] = head.split('<link rel="stylesheet"');
      expect(beforeSheet).toContain(THEME.head);
    });

    test(`${render}: no brand, the sheet is the surface's alone`, async () => {
      register(render);
      expect(cascadeOf(await headOf(render))).toBe(stylesFor(surfaceOf(render)));
    });
  }
});
