// A test process at an app root resolves `asset()` — and a stylesheet's Sass `asset()` — through
// the app's own site asset table, as the app's boot does. Without it every unit test importing a
// module whose stylesheet names a font died with X_ASSET_MISSING, on a fresh app.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no temporary-directory or recursive-delete API; node:fs is the only one.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { asset, setAssetResolver } from '@ultimat3/render';
import { compileStylesheet, setSassCacheDir } from '@ultimat3/render/server';
import { installAppAssets } from './app-assets';

let root = '';

async function seedApp(withConfig: boolean): Promise<string> {
  root = mkdtempSync(join(tmpdir(), 'x-app-assets-'));
  if (withConfig) await Bun.write(join(root, 'app.config.ts'), 'export const config = {};\n');
  mkdirSync(join(root, 'apps/web/site/assets/fonts'), { recursive: true });
  await Bun.write(join(root, 'apps/web/site/assets/fonts/x.woff2'), 'woff2 bytes');
  return root;
}

afterEach(() => {
  setAssetResolver(undefined);
  setSassCacheDir(undefined);
  if (root !== '') rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('unit · the app asset table in a test process', () => {
  test('an app root answers asset() with the hashed URL its boot would serve', async () => {
    const appRoot = await seedApp(true);
    expect(installAppAssets(appRoot)).toBe(true);
    expect(asset('assets/fonts/x.woff2')).toMatch(/^\/assets\/fonts\/x\.[0-9a-f]{8}\.woff2$/);
  });

  test('a stylesheet naming a font through Sass asset() compiles to that URL', async () => {
    const appRoot = await seedApp(true);
    installAppAssets(appRoot);
    // A cache of this test's own, so a compile is a compile and never another run's entry.
    setSassCacheDir(join(appRoot, '.sass-cache'));
    const sheet = join(appRoot, 'apps/web/shared/global.scss');
    const scss = "@font-face { font-family: X; src: url(asset('assets/fonts/x.woff2')); }\n";
    const { css } = compileStylesheet(sheet, scss);
    expect(css).toContain(`url("${asset('assets/fonts/x.woff2')}")`);
  });

  test('a file the app does not hold is still X_ASSET_MISSING, naming where it goes', async () => {
    const appRoot = await seedApp(true);
    installAppAssets(appRoot);
    expect(() => asset('assets/fonts/gone.woff2')).toThrow(
      expect.objectContaining({ code: 'X_ASSET_MISSING' }),
    );
  });

  test('a directory that is not an app installs nothing', async () => {
    const notApp = await seedApp(false);
    expect(installAppAssets(notApp)).toBe(false);
    expect(() => asset('assets/fonts/x.woff2')).toThrow(
      expect.objectContaining({ code: 'X_ASSET_MISSING' }),
    );
  });
});
