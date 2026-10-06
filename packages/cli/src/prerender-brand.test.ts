// The static export carries the app's brand exactly as the served process does: the exported file
// is the document a static host hands a browser, with no process behind it to add one later.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets } from '@ultimat3/render/server';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import { prerenderSite } from './prerender';
import { processRoot } from './process-root-fixture';
import { APP_THEME_MODULE } from './theme-brand';

const ROOT = processRoot(join(import.meta.dir, '..', '.prerender-brand-fixture'));
const UI = join(import.meta.dir, '../../ui/src/index.ts');

beforeEach(async () => {
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-brand-fixture', version: '1.0.0' }),
  );
  registerRoute({
    file: 'apps/web/site/page.tsx',
    config: defineRoute({
      render: 'static',
      hydrate: 'never',
      offline: 'precache',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Home', description: 'the landing page' }),
    }),
  });
});

afterEach(async () => {
  clearRoutes();
  clearStylesheets();
  await rm(ROOT, { recursive: true, force: true });
});

const exported = async (): Promise<string> => {
  const out = join(ROOT, 'static');
  await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
  return Bun.file(join(out, 'index.html')).text();
};

describe('x build --target static · the app brand', () => {
  test('the exported document carries the brand <style> in its head', async () => {
    await Bun.write(
      join(ROOT, APP_THEME_MODULE),
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    const head = (await exported()).split('</head>')[0] ?? '';
    expect(head).toContain(brandStyleTag(defineTheme({ preset: 'scifi' })));
  });

  test('an app with no theme module exports no <style>', async () => {
    expect(await exported()).not.toContain('<style');
  });
});
