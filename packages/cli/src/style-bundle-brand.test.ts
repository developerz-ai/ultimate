// The app's brand is the TAIL of every surface stylesheet: the cascade a document sees is the
// surface's rules, then the brand's — the sequence the old inline `<style>` after the `<link>` gave
// it — and the sheet's URL moves with the brand, so a re-branded deploy is a new immutable file.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearStylesheets, loadStylesheet, stylesFor } from '@ultimat3/render/server';
import { setBrandStyles, styleBundle, withBrand } from './style-bundle';

const SITE = '/srv/demo/apps/web/site/page.module.scss';
const APP = '/srv/demo/apps/web/app/feed/page.module.scss';
const BRAND = ':root{--color-accent:1 2 3}';

beforeEach(() => {
  clearStylesheets();
  setBrandStyles('');
});

afterEach(() => {
  clearStylesheets();
  setBrandStyles('');
});

const sheetOf = (surface: 'site' | 'app'): string => {
  const bundle = styleBundle();
  return bundle.chunkAt(bundle.hrefFor(surface) ?? '')?.css ?? '';
};

describe('unit · the brand rides every surface stylesheet, last', () => {
  test("each surface's sheet is its own rules, then the brand's", () => {
    loadStylesheet(SITE, '.hero{color:red}');
    loadStylesheet(APP, '.feed{color:blue}');
    setBrandStyles(BRAND);
    for (const surface of ['site', 'app'] as const) {
      expect(sheetOf(surface)).toBe(`${stylesFor(surface)}\n${BRAND}`);
    }
  });

  test('a brand over a surface with no CSS of its own is still a sheet the document links', () => {
    setBrandStyles(BRAND);
    expect(sheetOf('site')).toBe(BRAND);
  });

  test('the URL moves when the brand does, and clearing it returns the brandless sheet', () => {
    loadStylesheet(SITE, '.hero{color:red}');
    const plain = styleBundle().hrefFor('site');
    setBrandStyles(BRAND);
    const branded = styleBundle().hrefFor('site');
    expect(branded).not.toBe(plain);
    setBrandStyles(':root{--color-accent:4 5 6}');
    expect(styleBundle().hrefFor('site')).not.toBe(branded);
    setBrandStyles('');
    expect(styleBundle().hrefFor('site')).toBe(plain);
    expect(sheetOf('site')).toBe(stylesFor('site'));
  });

  test('withBrand: nothing to join is the other side unchanged', () => {
    expect(withBrand('a{}', '')).toBe('a{}');
    expect(withBrand('', 'b{}')).toBe('b{}');
    expect(withBrand('a{}', 'b{}')).toBe('a{}\nb{}');
  });
});
