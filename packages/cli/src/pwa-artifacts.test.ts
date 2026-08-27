// The reader that makes `pwa.enabled` a key something reads, and the two strings it hands every
// surface. `app-auth.test.ts`'s shape, including its fresh-tmpdir rule: `import()` caches by
// resolved specifier for the life of the process, so two configs at one path would hand the second
// test the first one's exports.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { loadPwaArtifacts, pwaManifestRoute, WEB_MANIFEST_PATH } from './pwa-artifacts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-pwa-artifacts-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeConfig = (body: string) => Bun.write(join(root, 'app.config.ts'), body);

const COLORS =
  "{ light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' }, " +
  "dark: { themeColor: '#101010', backgroundColor: '#0b0d1a' } }";

const installable = (extra = '') =>
  writeConfig(
    `export const config = { name: 'probe', pwa: { enabled: true, name: 'Probe App', ` +
      `colors: ${COLORS}${extra} } };\n`,
  );

describe('unit · the web manifest an installable app promises', () => {
  test('an enabled block produces a manifest and the head that names it', async () => {
    await installable();
    const artifacts = await loadPwaArtifacts(root);
    const manifest = JSON.parse(artifacts?.body ?? 'null') as Record<string, unknown>;

    expect(manifest['name']).toBe('Probe App');
    expect(manifest['theme_color']).toBe('#1b1f3b');
    expect(manifest['background_color']).toBe('#ffffff');
    expect(artifacts?.head).toContain(`<link rel="manifest" href="${WEB_MANIFEST_PATH}">`);
  });

  // The dark value is the half a single `theme_color` cannot carry: an installed dark app whose
  // status bar is painted from the light token flashes white on every launch. It only reaches a
  // browser through the media-scoped meta, so the head is the only place it can be asserted.
  test('both schemes reach the document, media-scoped', async () => {
    await installable();
    const head = (await loadPwaArtifacts(root))?.head ?? '';
    expect(head).toContain('content="#1b1f3b" media="(prefers-color-scheme: light)"');
    expect(head).toContain('content="#101010" media="(prefers-color-scheme: dark)"');
  });

  // A manifest naming an icon `/icons/*` will not mint is a broken install prompt, so the two come
  // off ONE `planIcons` call. Apple-touch icons are not manifest members and must arrive as links.
  test('the icons it names are the ones the asset surface serves', async () => {
    await installable();
    const artifacts = await loadPwaArtifacts(root);
    const manifest = JSON.parse(artifacts?.body ?? 'null') as {
      icons: readonly { src: string; sizes: string; purpose: string }[];
    };

    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) expect(icon.src.startsWith('/icons/')).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
    // Never in `icons`, always a link — Safari reads the link and ignores the manifest member.
    expect(manifest.icons.some((icon) => icon.src.includes('apple-touch'))).toBe(false);
    expect(artifacts?.head).toContain('rel="apple-touch-icon"');
  });

  // The whole point of the key. `enabled: false` must produce nothing at all rather than an empty
  // manifest: a document carrying `<link rel="manifest">` promises the app is installable, and a
  // browser that fetches it and finds no title reports an install failure nobody asked for.
  test('a disabled block produces nothing, and so does an absent one', async () => {
    await writeConfig("export const config = { name: 'probe', pwa: { enabled: false } };\n");
    expect(await loadPwaArtifacts(root)).toBeUndefined();
  });

  test('an app with no config file at all is not an error', async () => {
    expect(await loadPwaArtifacts(root)).toBeUndefined();
  });

  // `=== true`, not truthiness: `enabled` is the key this file exists to give a reader, and a
  // hand-written config that spelled it wrong must get no manifest rather than one nobody asked
  // for. `defineConfig` would have refused this one line above; a plain object never reaches it.
  test('a hand-written config that does not really say true is not installable', async () => {
    await writeConfig(
      `export const config = { pwa: { enabled: 'yes', name: 'Probe', colors: ${COLORS} } };\n`,
    );
    expect(await loadPwaArtifacts(root)).toBeUndefined();
  });

  test.each([
    ['no name', `{ enabled: true, colors: ${COLORS} }`],
    ['a blank name', `{ enabled: true, name: '  ', colors: ${COLORS} }`],
    ['no colours', "{ enabled: true, name: 'Probe' }"],
    ['one scheme only', "{ enabled: true, name: 'Probe', colors: { light: {} } }"],
    [
      'a blank colour',
      "{ enabled: true, name: 'Probe', colors: { light: { themeColor: '', " +
        "backgroundColor: '#fff' }, dark: { themeColor: '#000', backgroundColor: '#000' } } }",
    ],
  ])('a hand-written config with %s produces no manifest', async (_why, pwa) => {
    await writeConfig(`export const config = { pwa: ${pwa} };\n`);
    expect(await loadPwaArtifacts(root)).toBeUndefined();
  });

  // Public and cacheable, and it must not be immutable: the path carries no content hash, so an
  // app that renamed itself could never publish the change.
  test('the route is public, and served as a manifest rather than as JSON', async () => {
    await installable();
    const artifacts = await loadPwaArtifacts(root);
    if (artifacts === undefined) return expect.unreachable('the config was refused');
    const route = pwaManifestRoute(artifacts);

    expect(route.path).toBe(WEB_MANIFEST_PATH);
    expect(route.meta.auth).toBe('public');
    expect(route.meta.cache).toEqual({ mode: 'public', maxAgeSeconds: 3600 });

    // Through a real `UltimateRequest` and a real `RequestContext`, `dev-assets.test.ts`'s shape:
    // a cast would hide a dependency on either appearing later.
    const url = new URL(`http://dev.test${WEB_MANIFEST_PATH}`);
    const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
    const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
    const response = await route.handler(new UltimateRequest(new Request(url), ctx), ctx);
    expect(response.headers.get('content-type')).toContain('application/manifest+json');
    expect(await response.text()).toBe(artifacts.body);
  });
});
