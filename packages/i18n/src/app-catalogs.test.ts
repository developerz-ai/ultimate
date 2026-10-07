// The one reader of an app's declared locales: its `defineCatalogs()` in
// `packages/i18n/src/index.ts`, imported and read back — or `undefined` when no declaration ran.
// Fixtures import this package by absolute path: a module under the OS temp dir cannot resolve
// `@ultimat3/i18n`. One fixture directory PER CASE, because `import()` caches by path.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { APP_CATALOGS_PATH, loadAppCatalogs } from './app-catalogs';
import { resetCatalogs, resetLocaleConfig } from './context';
import { defineCatalogs } from './define-catalogs';

const scratch = mkdtempSync(join(tmpdir(), 'x-app-catalogs-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  resetCatalogs();
  resetLocaleConfig();
});

const I18N = JSON.stringify(join(import.meta.dir, 'index.ts'));

const app = async (name: string, module: string): Promise<string> => {
  const root = join(scratch, name);
  await Bun.write(join(root, APP_CATALOGS_PATH), module);
  return root;
};

const declaring = (fallback: string): string =>
  `import { defineCatalogs } from ${I18N};\n` +
  `export const catalogs = defineCatalogs({ default: '${fallback}', locales: { en: {}, '${fallback}': {} } });\n`;

describe('loadAppCatalogs', () => {
  // `index.ts` is in every island bundle; this module imports `node:path` and runs app code.
  test('is its own entry, never reached from the browser-safe index', async () => {
    const index = await Bun.file(join(import.meta.dir, 'index.ts')).text();
    expect(index).not.toContain('./app-catalogs');
    const manifest = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports['./app-catalogs']).toBe('./src/app-catalogs.ts');
  });

  test('the catalog module is where x new writes it', () => {
    expect(APP_CATALOGS_PATH).toBe('packages/i18n/src/index.ts');
  });

  test("reads the locales, default first, off the app's own defineCatalogs", async () => {
    const root = await app('declared', declaring('es-co'));
    expect(await loadAppCatalogs(root)).toEqual({
      locales: ['es-co', 'en'],
      defaultLocale: 'es-co',
    });
  });

  test('a module already imported still answers — the boot scan imports it first', async () => {
    const root = await app('cached', declaring('fr'));
    expect((await loadAppCatalogs(root))?.defaultLocale).toBe('fr');
    expect((await loadAppCatalogs(root))?.defaultLocale).toBe('fr');
  });

  test('a module that declares nothing is undefined, never an inherited declaration', async () => {
    // Some earlier import in this process declared catalogs; `localeConfig()` still answers them.
    defineCatalogs({ default: 'de', locales: { de: {} } });
    const root = await app('silent', 'export const nothing = 1;\n');
    expect(await loadAppCatalogs(root)).toBeUndefined();
  });

  test('a module that declares without exporting the set counts on its first import', async () => {
    const root = await app(
      'unexported',
      `import { defineCatalogs } from ${I18N};\ndefineCatalogs({ default: 'pt', locales: { pt: {} } });\n`,
    );
    expect(await loadAppCatalogs(root)).toEqual({ locales: ['pt'], defaultLocale: 'pt' });
  });

  test('no catalog module is undefined, and app.config.ts is never read for locales', async () => {
    expect(await loadAppCatalogs(join(scratch, 'absent'))).toBeUndefined();
    const root = join(scratch, 'config-only');
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const config = { name: 'demo', locales: ['fr'], defaultLocale: 'fr' };\n",
    );
    expect(await loadAppCatalogs(root)).toBeUndefined();
  });

  test('a module that will not import throws its own error — each caller decides', async () => {
    const root = await app('broken', "throw new TypeError('env missing');\n");
    await expect(loadAppCatalogs(root)).rejects.toThrow('env missing');
  });
});
