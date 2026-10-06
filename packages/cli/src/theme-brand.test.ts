// `apps/web/shared/theme.ts` has one reader, and what it hands the document is exactly what
// `@ultimat3/ui` says a brand is: the tag `brandStyleTag` writes and the hash `brandStyleCspSource`
// admits. An app with no theme module, or an empty brand, pays nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write and import() take one already joined.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
import { brandStyleCspSource, brandStyleTag, defineTheme } from '@ultimat3/ui';
import { inlineStyleSources } from './style-csp';
import { APP_THEME_MODULE, loadThemeBrand } from './theme-brand';

// The temp root is outside the workspace, so the module imports ui by absolute path.
const UI = join(import.meta.dir, '../../ui/src/index.ts');

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-theme-brand-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const writeTheme = (body: string) => Bun.write(join(root, APP_THEME_MODULE), body);

const codeOf = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
};

describe('unit · the app theme module has one reader', () => {
  test('no theme module: nothing, so an unthemed app emits no tag and no hash', async () => {
    expect(await loadThemeBrand(root)).toBeUndefined();
  });

  test("the scifi preset: ui's own tag, and the hash ui's own helper admits", async () => {
    await writeTheme(
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({ preset: 'scifi' });\n`,
    );
    const brand = defineTheme({ preset: 'scifi' });
    const loaded = await loadThemeBrand(root);
    expect(loaded?.head).toBe(brandStyleTag(brand));
    expect(loaded?.style).toBe(brand.css);
    // `style-src` is built from bodies (`inlineStyleSources`): the body this loader hands the boot
    // must hash to exactly the source ui documents as the one that admits the tag.
    expect(inlineStyleSources([loaded?.style ?? ''])).toEqual([brandStyleCspSource(brand)]);
    expect(cspHashSource(brand.css)).toBe(brandStyleCspSource(brand));
  });

  test('an empty brand is no brand: an empty <style> would cost a tag and a hash for nothing', async () => {
    await writeTheme(
      `import { defineTheme } from '${UI}';\nexport const brand = defineTheme({});\n`,
    );
    expect(await loadThemeBrand(root)).toBeUndefined();
  });

  test('a palette that fails AA fails the boot with ui’s own code, unwrapped', async () => {
    await writeTheme(
      `import { defineTheme } from '${UI}';\n` +
        "export const brand = defineTheme({ colors: { light: { accent: '235 235 235' } } });\n",
    );
    expect(await codeOf(() => loadThemeBrand(root))).toBe('X_UI_CONTRAST_INSUFFICIENT');
  });

  test('a module with no brand export is refused, not read as "no theme"', async () => {
    await writeTheme('export const theme = { css: "a{}" };\n');
    expect(await codeOf(() => loadThemeBrand(root))).toBe('X_CONFIG_INVALID');
  });

  test('a brand that is not a defineTheme() result is refused', async () => {
    await writeTheme("export const brand = 'body{color:red}';\n");
    expect(await codeOf(() => loadThemeBrand(root))).toBe('X_CONFIG_INVALID');
  });

  test('a hand-built brand that could close its <style> element is refused', async () => {
    await writeTheme(
      "export const brand = { css: ':root{}</style><script>alert(1)</script><style>' };\n",
    );
    expect(await codeOf(() => loadThemeBrand(root))).toBe('X_CONFIG_INVALID');
  });
});
