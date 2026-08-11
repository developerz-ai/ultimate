// The glyph gate is what stands between generated data and an attribute sink, so the cases that
// matter are the rejections: an unknown tag, an attribute nobody declared, and a literal colour.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES, UiError } from '../errors';
import { iconCircleAlert } from '../icons/glyphs/circle-alert';
import { iconSearch } from '../icons/glyphs/search';
import { iconSquare } from '../icons/glyphs/square';
import { ICON_TAGS, type IconGlyph, iconElements, isIconTag } from './icon-glyph';

describe('iconElements', () => {
  test('passes a real Lucide glyph through, in source order', () => {
    expect(iconElements(iconSearch)).toEqual([
      { tag: 'path', attrs: { d: 'm21 21-4.34-4.34' } },
      { tag: 'circle', attrs: { cx: '11', cy: '11', r: '8' } },
    ]);
  });

  test('keeps every shape Lucide draws with, not just paths', () => {
    expect(iconElements(iconCircleAlert).map((element) => element.tag)).toEqual([
      'circle',
      'line',
      'line',
    ]);
    expect(iconElements(iconSquare)).toEqual([
      { tag: 'rect', attrs: { width: '18', height: '18', x: '3', y: '3', rx: '2' } },
    ]);
  });

  test('rejects a tag outside the table', () => {
    const glyph: IconGlyph = [['script', { d: 'alert(1)' }]];
    expect(() => iconElements(glyph)).toThrow(UiError);
    try {
      iconElements(glyph);
    } catch (error) {
      expect((error as UiError).code).toBe(UI_ERROR_CODES.invalidValue);
      expect((error as UiError).cause).toContain('<script>');
    }
  });

  test('rejects an attribute the tag never declares — that is the injection', () => {
    expect(() => iconElements([['path', { onload: 'steal()' }]])).toThrow(/attribute "onload"/);
    expect(() => iconElements([['circle', { d: 'M0 0' }]])).toThrow(/attribute "d"/);
  });

  test('rejects a literal colour, because paint comes from the theme', () => {
    expect(() => iconElements([['circle', { fill: '#ff0000' }]])).toThrow(/currentColor/);
    expect(iconElements([['circle', { fill: 'currentColor' }]])).toHaveLength(1);
    expect(iconElements([['circle', { fill: 'none' }]])).toHaveLength(1);
  });

  test('an empty glyph is an empty element list, not a throw', () => {
    expect(iconElements([])).toEqual([]);
  });
});

describe('ICON_TAGS', () => {
  test('isIconTag answers for the table and nothing else', () => {
    for (const tag of Object.keys(ICON_TAGS)) expect(isIconTag(tag)).toBe(true);
    expect(isIconTag('svg')).toBe(false);
    expect(isIconTag('toString')).toBe(false);
  });
});
