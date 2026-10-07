// One manifest per routed locale, each in its own language, and the install sheet members an app
// declares. `pwa-artifacts.test.ts`'s fresh-tmpdir rule: `import()` caches by resolved specifier.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { defineHttpConfig, requestContext, UltimateRequest } from '@ultimat3/http';
import { configureLocales, resetLocaleConfig } from '@ultimat3/i18n';
import { appLocaleSet, UNDECLARED_LOCALES } from '@ultimat3/i18n/app-catalogs';
import { islandBundle } from './island-bundle';
import { otherLocaleSegments } from './page-speculation';
import type { PwaArtifacts } from './pwa-artifacts';
import { loadPwaArtifacts, pwaManifestRoute } from './pwa-artifacts';
import { styleBundleOf } from './style-bundle';
import { serviceWorkerArtifacts } from './sw-artifacts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-pwa-locales-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  resetLocaleConfig();
});

const COLORS =
  "{ light: { themeColor: '#21378C', backgroundColor: '#EEF0F5' }, " +
  "dark: { themeColor: '#0B0D1A', backgroundColor: '#0B0D1A' } }";

/** The app's catalogs: the one place its locales are declared (25.0.0). Default first. */
type Locales = readonly [string, ...string[]];

// By absolute path: a module under /tmp cannot resolve `@ultimat3/i18n`.
const I18N = JSON.stringify(Bun.resolveSync('@ultimat3/i18n', import.meta.dir));

const load = async (locales: Locales, pwa = ''): Promise<PwaArtifacts> => {
  const sources = locales.map((locale) => `'${locale}': {}`).join(', ');
  await Bun.write(
    join(root, 'packages/i18n/src/index.ts'),
    `import { defineCatalogs } from ${I18N};\n` +
      `export const catalogs = defineCatalogs({ default: '${locales[0]}', locales: { ${sources} } });\n`,
  );
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'probe', pwa: { enabled: true, name: 'Notificado', ` +
      `offline: { fallback: '/offline' }, colors: ${COLORS}${pwa} } };\n`,
  );
  const artifacts = await loadPwaArtifacts(root);
  if (artifacts === undefined) return expect.unreachable('the config was refused');
  return artifacts;
};

const parse = (body: string | undefined): Record<string, unknown> =>
  JSON.parse(body ?? 'null') as Record<string, unknown>;

const bodyAt = (artifacts: PwaArtifacts, path: string): Record<string, unknown> =>
  parse(artifacts.manifests.find((manifest) => manifest.path === path)?.body);

const TWO_LOCALES: Locales = ['es-co', 'en'];

describe('a manifest per routed locale', () => {
  test('the default manifest speaks the default locale, never a hardcoded en', async () => {
    const artifacts = await load(TWO_LOCALES);
    const manifest = parse(artifacts.body);
    expect(manifest['lang']).toBe('es-co');
    expect(manifest['start_url']).toBe('/');
  });

  test('every other locale has its own manifest at its own prefix, starting in that locale', async () => {
    const artifacts = await load(TWO_LOCALES);
    expect(artifacts.manifests.map((manifest) => manifest.path)).toEqual([
      '/manifest.webmanifest',
      '/en/manifest.webmanifest',
    ]);
    const en = bodyAt(artifacts, '/en/manifest.webmanifest');
    expect(en['lang']).toBe('en');
    expect(en['start_url']).toBe('/en/');
    expect(en['scope']).toBe('/');
  });

  test('both carry one id, so a browser sees one app installed from either language', async () => {
    const artifacts = await load(TWO_LOCALES);
    expect(parse(artifacts.body)['id']).toBe('/');
    expect(bodyAt(artifacts, '/en/manifest.webmanifest')['id']).toBe('/');
  });

  test('a document links its own locale’s manifest', async () => {
    const artifacts = await load(TWO_LOCALES);
    expect(artifacts.headFor('en')).toContain(
      '<link rel="manifest" href="/en/manifest.webmanifest">',
    );
    expect(artifacts.headFor('es-co')).toContain(
      '<link rel="manifest" href="/manifest.webmanifest">',
    );
    expect(artifacts.head).toBe(artifacts.headFor('es-co'));
  });

  test('the served route answers the locale the URL named', async () => {
    const artifacts = await load(TWO_LOCALES);
    const route = pwaManifestRoute(artifacts);
    expect(route.meta.localeSource).toBe('path');
    const url = new URL('http://dev.test/manifest.webmanifest');
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = requestContext({ url, method: 'GET', role: 'web', config });
    ctx.locale = 'en';
    const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(parse(await response.text())['lang']).toBe('en');
  });

  test('a single-locale app gets one manifest, in its one locale', async () => {
    const artifacts = await load(['fr']);
    expect(artifacts.manifests.map((manifest) => manifest.path)).toEqual(['/manifest.webmanifest']);
    expect(parse(artifacts.body)['lang']).toBe('fr');
  });
});

describe('the install sheet members an app declares', () => {
  const MEMBERS =
    ", id: '/', description: { 'es-co': 'Notificaciones con constancia', en: 'Notices with proof' }" +
    ", categories: ['business', 'productivity']" +
    ", shortcuts: [{ name: { 'es-co': 'Panel', en: 'Dashboard' }, url: '/panel'," +
    " icons: [{ src: '/assets/panel.png', sizes: '96x96', type: 'image/png' }] }]" +
    ", screenshots: [{ src: { 'es-co': '/assets/home-es.png', en: '/assets/home-en.png' }," +
    " sizes: '1280x800', type: 'image/png', formFactor: 'wide', label: { 'es-co': 'Inicio', en: 'Home' } }]";

  /** The three images MEMBERS names, as committed files under the site's assets. */
  const writeAssets = async (): Promise<void> => {
    for (const name of ['panel', 'home-es', 'home-en']) {
      await Bun.write(join(root, `apps/web/site/assets/${name}.png`), `png-${name}`);
    }
  };
  const HASHED = (name: string): RegExp => new RegExp(`^/assets/${name}\\.[0-9a-f]{8}\\.png$`);

  // The site serves an asset ONLY at its content-hashed URL, and the manifest took `src` verbatim,
  // so an `/assets/…` screenshot was a 404 in the install sheet unless the app hashed it itself.
  test('an asset-path screenshot or shortcut icon that has no file is refused at boot', async () => {
    const refused = await load(TWO_LOCALES, MEMBERS).then(
      () => 'loaded',
      (error: { code?: string }) => error.code,
    );
    expect(refused).toBe('X_ASSET_MISSING');
  });

  test('asset-path screenshots and shortcut icons answer their content-hashed URL', async () => {
    await writeAssets();
    const artifacts = await load(TWO_LOCALES, MEMBERS);
    const es = parse(artifacts.body) as {
      screenshots: { src: string }[];
      shortcuts: { icons: { src: string }[] }[];
    };
    const en = bodyAt(artifacts, '/en/manifest.webmanifest') as typeof es;
    expect(es.screenshots[0]?.src).toMatch(HASHED('home-es'));
    expect(en.screenshots[0]?.src).toMatch(HASHED('home-en'));
    expect(en.shortcuts[0]?.icons[0]?.src).toMatch(HASHED('panel'));
  });

  // An absolute path outside `/assets/` is the app's own route and is named as written; a
  // shortcut icon's `src` is not screened by core, so an off-site one is carried verbatim too.
  test('a src that is not an asset path passes untouched', async () => {
    const artifacts = await load(
      TWO_LOCALES,
      ", screenshots: [{ src: '/media/wide.png', sizes: '1280x800', type: 'image/png' }]" +
        ", shortcuts: [{ name: 'Panel', url: '/panel'," +
        " icons: [{ src: 'https://cdn.test/panel.png', sizes: '96x96', type: 'image/png' }] }]",
    );
    const body = parse(artifacts.body) as {
      screenshots: { src: string }[];
      shortcuts: { icons: { src: string }[] }[];
    };
    expect(body.screenshots[0]?.src).toBe('/media/wide.png');
    expect(body.shortcuts[0]?.icons[0]?.src).toBe('https://cdn.test/panel.png');
  });

  // A manifest `src` resolves against the manifest's own URL, so core refuses a screenshot that is
  // not an absolute path — an off-site URL included — before any manifest is built.
  test('a screenshot src that is not an absolute path is refused at boot', async () => {
    const refused = await load(
      TWO_LOCALES,
      ", screenshots: [{ src: 'https://cdn.test/wide.png', sizes: '1280x800', type: 'image/png' }]",
    ).then(
      () => 'loaded',
      (error: { code?: string }) => error.code,
    );
    expect(refused).toBe('X_CONFIG_INVALID');
  });

  test('each manifest carries them in its own language, with its own URLs', async () => {
    await writeAssets();
    const artifacts = await load(TWO_LOCALES, MEMBERS);
    const es = parse(artifacts.body);
    const en = bodyAt(artifacts, '/en/manifest.webmanifest');
    expect(es['description']).toBe('Notificaciones con constancia');
    expect(en['description']).toBe('Notices with proof');
    expect(es['categories']).toEqual(['business', 'productivity']);
    expect(es['shortcuts']).toEqual([
      {
        name: 'Panel',
        url: '/panel',
        icons: [{ src: expect.stringMatching(HASHED('panel')), sizes: '96x96', type: 'image/png' }],
      },
    ]);
    expect(en['shortcuts']).toEqual([
      {
        name: 'Dashboard',
        url: '/en/panel',
        icons: [{ src: expect.stringMatching(HASHED('panel')), sizes: '96x96', type: 'image/png' }],
      },
    ]);
    expect(en['screenshots']).toEqual([
      {
        src: expect.stringMatching(HASHED('home-en')),
        sizes: '1280x800',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Home',
      },
    ]);
  });

  test('a locale a record does not name falls back to the default locale’s text', async () => {
    const artifacts = await load(
      ['es-co', 'en', 'pt'],
      ", description: { 'es-co': 'Solo en español' }",
    );
    expect(bodyAt(artifacts, '/pt/manifest.webmanifest')['description']).toBe('Solo en español');
  });

  test('an app that declares none gets none, and no empty member', async () => {
    const manifest = parse((await load(TWO_LOCALES)).body);
    for (const key of ['description', 'categories', 'shortcuts', 'screenshots']) {
      expect(manifest).not.toHaveProperty(key);
    }
  });
});

// One answer for an app with no catalogs, from every consumer: the manifests, the worker built off
// them, and the speculation rules' locale segments. The process's locale config is set to another
// app's declaration first — the shape that leaked through a blind `localeConfig()` read.
describe('an app with no catalogs', () => {
  test('the manifest, the worker and the speculation rules all name the default alone', async () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    await Bun.write(
      join(root, 'app.config.ts'),
      `export const config = { name: 'probe', pwa: { enabled: true, name: 'Probe', ` +
        `offline: { fallback: '/offline' }, colors: ${COLORS} } };\n`,
    );
    const artifacts = await loadPwaArtifacts(root);
    if (artifacts === undefined) return expect.unreachable('the config was refused');
    expect(artifacts.manifests.map((manifest) => manifest.locale)).toEqual(['en']);
    expect(artifacts.locales).toEqual({ routed: ['en'], fallback: 'en' });
    const worker = serviceWorkerArtifacts({
      pwa: artifacts,
      buildId: 'b1',
      routes: [],
      islands: islandBundle([]),
      styles: styleBundleOf([]),
    });
    expect(worker?.source).toContain('const OFFLINE_LOCALES=[];');
    expect(await appLocaleSet(root)).toBe(UNDECLARED_LOCALES);
    expect(otherLocaleSegments(await appLocaleSet(root))).toEqual([]);
  });
});
