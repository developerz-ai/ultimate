// The container half of the brand seam, booted for real: `ROLE=web` over an app whose theme module
// declares a brand serves a document carrying the brand `<style>`, under an ENFORCED policy whose
// `style-src` admits every inline style body that document holds. `x dev` is report-only, so this
// is the one process where a missing hash is an unstyled page.
//
// The app-level favicon is the container's other document-level head: `site.favicon` in
// `app.config.ts` names one SVG, and every document the container serves carries it at the
// content-hashed URL `/assets/*` answers.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; the fixture app root is joined to this directory.
import { join } from 'node:path';
import { resetLifecycle } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import { inlineStyleBodies } from './error-page-csp';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';
import { siteAssetTable } from './site-assets';
import { APP_THEME_MODULE } from './theme-brand';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-brand-fixture'));
// Its own root: `app.config.ts` is imported once per PATH, so a second fixture at the same path
// would read the first one's module and declare a brand where this one declares a favicon.
const FAVICON_ROOT = processRoot(join(import.meta.dir, '..', '.serve-favicon-fixture'));
const UI = join(import.meta.dir, '../../ui/src/index.ts');
const RENDER = join(import.meta.dir, '../../render/src/index.ts');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(FAVICON_ROOT, { recursive: true, force: true });
});

describe('integration · ROLE=web serves the app brand, admitted', () => {
  test('the document carries the brand, and style-src hashes every inline style in it', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-brand-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-brand-fixture' });\n",
    );
    await Bun.write(
      join(ROOT, APP_THEME_MODULE),
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    await Bun.write(
      join(ROOT, 'apps/web/site/page.tsx'),
      `import { defineRoute } from '${RENDER}';\n` +
        'export const config = defineRoute({ render: "ssr", hydrate: "never", offline: "network-only",' +
        ' meta: () => ({ title: "Home", description: "the page the brand is asked of" }) });\n' +
        'export default function Page() { return null; }\n',
    );
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const web = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 });
    try {
      const response = await fetch(`${web.url}/`, { headers: { accept: 'text/html' } });
      const html = await response.text();
      expect(html.split('</head>')[0]).toContain(brandStyleTag(defineTheme({ preset: 'scifi' })));
      const csp = response.headers.get('content-security-policy') ?? '';
      const styleSrc = csp.split(';').find((part) => part.trim().startsWith('style-src')) ?? '';
      const bodies = inlineStyleBodies(html);
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) expect(styleSrc).toContain(cspHashSource(body));
    } finally {
      await web.stop();
      // stop() drains the PROCESS lifecycle (a module global): left draining, every later file in
      // this process answered 503 X_DRAINING (main CI packages 2/2, 2026-10-20).
      resetLifecycle();
    }
  }, 120_000);
});

describe('integration · ROLE=web serves the app favicon', () => {
  test('every document carries it, at the content-hashed URL the asset surface serves', async () => {
    await rm(FAVICON_ROOT, { recursive: true, force: true });
    await Bun.write(
      join(FAVICON_ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-favicon-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(FAVICON_ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        'export const config = defineConfig({\n' +
        "  name: 'serve-favicon-fixture',\n" +
        "  site: { favicon: 'assets/brand/icon.svg' },\n" +
        '});\n',
    );
    await mkdir(join(FAVICON_ROOT, 'apps/web/site/assets/brand'), { recursive: true });
    await Bun.write(
      join(FAVICON_ROOT, 'apps/web/site/assets/brand/icon.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await Bun.write(
      join(FAVICON_ROOT, 'apps/web/site/page.tsx'),
      `import { defineRoute } from '${RENDER}';\n` +
        'export const config = defineRoute({ render: "ssr", hydrate: "never", offline: "network-only",' +
        ' meta: () => ({ title: "Home", description: "the page the favicon is asked of" }) });\n' +
        'export default function Page() { return null; }\n',
    );
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(FAVICON_ROOT, '.x') };
    const web = await serveApp({ root: FAVICON_ROOT, env, role: 'web', port: 0, metricsPort: 0 });
    try {
      // The URL the app's own site asset table mints — never the raw path the config named.
      const url = siteAssetTable(FAVICON_ROOT).resolve('assets/brand/icon.svg').url;
      const response = await fetch(`${web.url}/`, { headers: { accept: 'text/html' } });
      const html = await response.text();
      expect(html.split('</head>')[0]).toContain(
        `<link rel="icon" type="image/svg+xml" href="${url}">`,
      );
      // And the file behind it is served at that very URL: the href names bytes the surface answers.
      const asset = await fetch(`${web.url}${url}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe('image/svg+xml');
    } finally {
      await web.stop();
      // stop() drains the PROCESS lifecycle (a module global): left draining, every later file in
      // this process answered 503 X_DRAINING (main CI packages 2/2, 2026-10-20).
      resetLifecycle();
    }
  }, 120_000);
});
