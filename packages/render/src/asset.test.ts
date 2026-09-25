// The seam half of `asset()`: what it refuses before any table is asked, what it answers with no
// table installed, and that an installed table is the one answer. The table itself — hashing,
// copying, serving — is `@ultimat3/cli`'s `site-assets.test.ts`.

import { afterEach, describe, expect, test } from 'bun:test';
import type { AssetPath } from './asset';
import { asset, assetPathProblem, setAssetResolver } from './asset';
import { AssetMissingError } from './errors';

afterEach(() => setAssetResolver(undefined));

describe('asset()', () => {
  test('with no table installed it refuses by code, naming the island mistake', () => {
    expect(() => asset('assets/hero.avif')).toThrow(
      expect.objectContaining({ code: 'X_ASSET_MISSING' }),
    );
  });

  test('a path escaping assets/ is refused before the table is asked', () => {
    let asked = 0;
    setAssetResolver((path) => {
      asked += 1;
      return `/${path}`;
    });
    // The type admits these: `${string}` swallows the `..`. The runtime check is the backstop.
    for (const path of ['assets/../app.config.avif', 'assets//x.png', 'assets/./x.png']) {
      expect(() => asset(path as AssetPath)).toThrow(
        expect.objectContaining({ code: 'X_ASSET_MISSING' }),
      );
    }
    expect(asked).toBe(0);
  });

  test('an installed table is the answer, and its refusal passes through untouched', () => {
    setAssetResolver((path) => {
      if (path === 'assets/hero.avif') return '/assets/hero.0123abcd.avif';
      throw new AssetMissingError(`fixture resolver: ${path} is not in the table`, 'fixture');
    });
    expect(asset('assets/hero.avif')).toBe('/assets/hero.0123abcd.avif');
    expect(() => asset('assets/missing.png')).toThrow('fixture resolver');
  });
});

describe('assetPathProblem', () => {
  test('names each way a path can fail to be an asset', () => {
    expect(assetPathProblem('hero.avif')).toContain('not under assets/');
    expect(assetPathProblem('assets')).toContain('not under assets/');
    expect(assetPathProblem('assets\\x.png')).toContain('backslash');
    expect(assetPathProblem('assets/../x.png')).toContain('".."');
    expect(assetPathProblem('assets/notes.txt')).toContain('extension');
    expect(assetPathProblem('assets/.avif')).toContain('extension');
  });

  test('accepts nested paths and every served extension, case-insensitively', () => {
    expect(assetPathProblem('assets/brand/logo.svg')).toBeUndefined();
    expect(assetPathProblem('assets/films/explainer.en.vtt')).toBeUndefined();
    expect(assetPathProblem('assets/hero.AVIF')).toBeUndefined();
  });
});
