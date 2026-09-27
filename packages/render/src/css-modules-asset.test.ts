// `asset()` from Sass: a stylesheet names a site asset by the same path a page passes `asset()`,
// and the compiled CSS carries the content-hashed URL `/assets/*` serves. Sass `url()` could not
// call the TypeScript `asset()`, so notificado.co generated its `@font-face` rules by script.
//
// Pinned: the rewrite, its use inside `url()`, the refusal of a missing file as `X_ASSET_MISSING`
// (never a Sass stack), and a disk-cache entry that goes stale when the asset's hash moves.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove.
import { tmpdir } from 'node:os'; // why: Bun exposes no temp-directory API.
import { join } from 'node:path'; // why: Bun ships no path API.
import { type AssetPath, setAssetResolver } from './asset';
import { compileStylesheet } from './css-modules';
import { AssetMissingError } from './errors';
import { setSassCacheDir } from './sass-cache';

const FILE = join(import.meta.dir, 'fonts.module.scss');
const CACHE = join(tmpdir(), `x-sass-asset-${process.pid}`);

const FONT_FACE = `@font-face {
  font-family: Inter;
  src: url(asset('assets/fonts/inter.woff2')) format('woff2');
}
.hero { background-image: url(asset("assets/hero.avif")); }
`;

let hash = '3f2a1b9c';
const table = (path: AssetPath): string => {
  if (path.includes('missing')) {
    throw new AssetMissingError(`asset("${path}"): no file`, 'add the file');
  }
  const dot = path.lastIndexOf('.');
  return `/${path.slice(0, dot)}.${hash}${path.slice(dot)}`;
};

beforeAll(() => setSassCacheDir(CACHE));
afterEach(() => setAssetResolver(undefined));
afterAll(async () => {
  setSassCacheDir(undefined);
  await rm(CACHE, { recursive: true, force: true });
});

describe('unit · asset() inside a stylesheet', () => {
  test('resolves to the hashed URL, inside url(), for a font and an image alike', () => {
    setAssetResolver(table);
    const { css } = compileStylesheet(FILE, FONT_FACE);
    expect(css).toContain('url("/assets/fonts/inter.3f2a1b9c.woff2") format("woff2")');
    expect(css).toContain('url("/assets/hero.3f2a1b9c.avif")');
    expect(css).not.toContain('asset(');
  });

  test('a cached compile is not served once the asset hashes differently', () => {
    setAssetResolver(table);
    const source = `${FONT_FACE}/* cache probe */\n`;
    expect(compileStylesheet(FILE, source).css).toContain('inter.3f2a1b9c.woff2');
    hash = '0badf00d';
    try {
      expect(compileStylesheet(FILE, source).css).toContain('inter.0badf00d.woff2');
    } finally {
      hash = '3f2a1b9c';
    }
  });

  test('a missing file is X_ASSET_MISSING naming the path, not a Sass stack', () => {
    setAssetResolver(table);
    expect(() =>
      compileStylesheet(FILE, `.a { background: url(asset('assets/missing.png')); }`),
    ).toThrow(expect.objectContaining({ code: 'X_ASSET_MISSING' }));
  });

  test('a path outside assets/ is refused before any table is asked', () => {
    setAssetResolver(table);
    expect(() =>
      compileStylesheet(FILE, `.a { background: url(asset('../secret.png')); }`),
    ).toThrow(expect.objectContaining({ code: 'X_ASSET_MISSING' }));
  });
});
