// The static build, once per routed locale: the default at the export root, every other locale
// under `<locale>/`, each document in its own `<html lang>` with an absolute hreflang cluster. The
// bug this closes: `createContext()` defaulted the build's locale to core's `en`, so a Spanish-
// default site shipped `index.html` as `lang="en"` while the served process answered Spanish.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { clearStylesheets } from '@ultimat3/render/server';
import { prerenderSite } from './prerender';

const ROOT = join(import.meta.dir, '..', '.prerender-locale-fixture');

const page = defineRoute({
  render: 'static',
  hydrate: 'never',
  offline: 'precache',
  meta: ({ locale }) => ({ title: `Precios ${locale}`, description: 'the pricing page' }),
});

beforeEach(async () => {
  // Process-global and merged: a file before this one that configured locales would otherwise
  // decide what "an app that declared none" means here.
  resetLocaleConfig();
  clearRoutes();
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'prerender-locale-fixture', version: '1.0.0' }),
  );
});

afterEach(async () => {
  clearRoutes();
  clearStylesheets();
  resetLocaleConfig();
  await rm(ROOT, { recursive: true, force: true });
});

const read = (out: string, file: string) => Bun.file(join(out, file)).text();

describe('prerender per locale — refusals', () => {
  test('an app that declared no locales writes no locale directories', async () => {
    registerRoute({ file: 'apps/web/site/page.tsx', config: page });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    expect(report.pages.map((p) => p.file)).toEqual(['index.html']);
    expect(await Bun.file(join(out, 'en', 'index.html')).exists()).toBe(false);
  });

  test('the default locale is never written under its own prefix', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    registerRoute({ file: 'apps/web/site/page.tsx', config: page });
    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    expect(await Bun.file(join(out, 'es-co', 'index.html')).exists()).toBe(false);
  });
});

describe('prerender per locale', () => {
  test('index.html is lang="es-co" and en/index.html is lang="en"', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    registerRoute({ file: 'apps/web/site/page.tsx', config: page });
    registerRoute({ file: 'apps/web/site/precios/page.tsx', config: page });
    const out = join(ROOT, 'static');
    const report = await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });

    expect(report.pages.map((p) => [p.path, p.locale, p.file]).sort()).toEqual([
      ['/', 'es-co', 'index.html'],
      ['/en/', 'en', 'en/index.html'],
      ['/en/precios', 'en', 'en/precios/index.html'],
      ['/precios', 'es-co', 'precios/index.html'],
    ]);
    const home = await read(out, 'index.html');
    const english = await read(out, 'en/index.html');
    expect(home).toContain('<html lang="es-co"');
    expect(english).toContain('<html lang="en"');
    // `meta` was handed the document's own locale.
    expect(home).toContain('<title>Precios es-co</title>');
    expect(english).toContain('<title>Precios en</title>');
  });

  test('each document carries an absolute canonical and the full hreflang cluster', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    registerRoute({ file: 'apps/web/site/precios/page.tsx', config: page });
    const out = join(ROOT, 'static');
    await prerenderSite({ root: ROOT, out, origin: 'https://example.test' });
    const english = await read(out, 'en/precios/index.html');

    expect(english).toContain('<link rel="canonical" href="https://example.test/en/precios">');
    expect(english).toContain(
      '<link rel="alternate" hreflang="es-CO" href="https://example.test/precios">',
    );
    expect(english).toContain(
      '<link rel="alternate" hreflang="en" href="https://example.test/en/precios">',
    );
    expect(english).toContain(
      '<link rel="alternate" hreflang="x-default" href="https://example.test/precios">',
    );
    expect(english).toContain('<meta property="og:locale" content="en">');
    expect(english).toContain('<meta property="og:locale:alternate" content="es_CO">');
  });
});
