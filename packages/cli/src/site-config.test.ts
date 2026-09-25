// The public origin every absolute URL is built against, and the two `app.config.ts` keys behind it.
import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { loadSiteSettings, NO_SITE_SETTINGS, originWarning, publicOrigin } from './site-config';

const ROOT = join(import.meta.dir, '..', '.site-config-fixture');

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('loadSiteSettings — refusals', () => {
  test('no app.config.ts, or one with no site section, is "not declared" — never a crash', async () => {
    expect(await loadSiteSettings(join(ROOT, 'absent'))).toEqual(NO_SITE_SETTINGS);
    await Bun.write(join(ROOT, 'bare', 'app.config.ts'), 'export const config = { name: "x" };\n');
    expect(await loadSiteSettings(join(ROOT, 'bare'))).toEqual(NO_SITE_SETTINGS);
  });
});

describe('loadSiteSettings', () => {
  test('reads site.origin (trailing slash dropped) and seo.robots.disallow', async () => {
    await Bun.write(
      join(ROOT, 'app', 'app.config.ts'),
      "export const config = { site: { origin: 'https://notificado.co/' }," +
        " seo: { robots: { disallow: ['/panel'] } } };\n",
    );
    expect(await loadSiteSettings(join(ROOT, 'app'))).toEqual({
      origin: 'https://notificado.co',
      disallow: ['/panel'],
    });
  });
});

describe('publicOrigin', () => {
  const site = { origin: 'https://config.test', disallow: [] };

  test('APP_URL, then SITE_ORIGIN, then site.origin, then nothing', () => {
    expect(
      publicOrigin({ APP_URL: 'https://app.test/', SITE_ORIGIN: 'https://s.test' }, site),
    ).toBe('https://app.test');
    expect(publicOrigin({ APP_URL: ' ', SITE_ORIGIN: 'https://s.test' }, site)).toBe(
      'https://s.test',
    );
    expect(publicOrigin({}, site)).toBe('https://config.test');
    expect(publicOrigin({}, NO_SITE_SETTINGS)).toBeUndefined();
  });

  test('a production build with no origin warns; any other build, or a declared one, does not', () => {
    expect(originWarning('production', undefined)).toHaveLength(1);
    expect(originWarning('production', 'https://notificado.co')).toEqual([]);
    expect(originWarning('development', undefined)).toEqual([]);
  });
});
