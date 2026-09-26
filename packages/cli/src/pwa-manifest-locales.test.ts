// One manifest per routed locale, each in its own language, and the install sheet members an app
// declares. `pwa-artifacts.test.ts`'s fresh-tmpdir rule: `import()` caches by resolved specifier.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import type { PwaArtifacts } from './pwa-artifacts';
import { loadPwaArtifacts, pwaManifestRoute } from './pwa-artifacts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-pwa-locales-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const COLORS =
  "{ light: { themeColor: '#21378C', backgroundColor: '#EEF0F5' }, " +
  "dark: { themeColor: '#0B0D1A', backgroundColor: '#0B0D1A' } }";

const load = async (top: string, pwa = ''): Promise<PwaArtifacts> => {
  await Bun.write(
    join(root, 'app.config.ts'),
    `export const config = { name: 'probe', ${top} pwa: { enabled: true, name: 'Notificado', ` +
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

const TWO_LOCALES = "locales: ['es-co', 'en'], defaultLocale: 'es-co',";

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
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    ctx.locale = 'en';
    const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(parse(await response.text())['lang']).toBe('en');
  });

  test('a single-locale app gets one manifest, in its one locale', async () => {
    const artifacts = await load("locales: ['fr'], defaultLocale: 'fr',");
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

  test('each manifest carries them in its own language, with its own URLs', async () => {
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
        icons: [{ src: '/assets/panel.png', sizes: '96x96', type: 'image/png' }],
      },
    ]);
    expect(en['shortcuts']).toEqual([
      {
        name: 'Dashboard',
        url: '/en/panel',
        icons: [{ src: '/assets/panel.png', sizes: '96x96', type: 'image/png' }],
      },
    ]);
    expect(en['screenshots']).toEqual([
      {
        src: '/assets/home-en.png',
        sizes: '1280x800',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Home',
      },
    ]);
  });

  test('a locale a record does not name falls back to the default locale’s text', async () => {
    const artifacts = await load(
      "locales: ['es-co', 'en', 'pt'], defaultLocale: 'es-co',",
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
