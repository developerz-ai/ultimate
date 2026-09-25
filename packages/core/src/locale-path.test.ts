// Locale path arithmetic over an explicit list — the half a browser chunk may import.
import { describe, expect, test } from 'bun:test';
import { localeSegment, localizePath, splitLocalePath } from './locale-path';

const locales = ['es-co', 'en', 'pt-BR'];

describe('splitLocalePath', () => {
  test('no prefix: an unlisted segment, an uppercase spelling, the root, a relative path', () => {
    expect(splitLocalePath('/fr/x', locales, 'es-co')).toBeUndefined();
    expect(splitLocalePath('/EN/x', locales, 'es-co')).toBeUndefined();
    expect(splitLocalePath('/', locales, 'es-co')).toBeUndefined();
    expect(splitLocalePath('en/x', locales, 'es-co')).toBeUndefined();
  });

  test('a listed segment splits, answered in the listed spelling', () => {
    expect(splitLocalePath('/pt-br/x', locales, 'es-co')).toEqual({
      locale: 'pt-BR',
      path: '/x',
      isDefault: false,
    });
    expect(splitLocalePath('/es-co', locales, 'es-co')).toEqual({
      locale: 'es-co',
      path: '/',
      isDefault: true,
    });
  });
});

describe('localizePath', () => {
  test('default unprefixed, others prefixed, root as a directory, prefix re-spelled', () => {
    expect(localizePath('/x', 'es-co', locales, 'es-co')).toBe('/x');
    expect(localizePath('/x', 'pt-BR', locales, 'es-co')).toBe('/pt-br/x');
    expect(localizePath('/', 'en', locales, 'es-co')).toBe('/en/');
    expect(localizePath('/en/x', 'pt-BR', locales, 'es-co')).toBe('/pt-br/x');
    expect(localizePath('x?q=1', 'en', locales, 'es-co')).toBe('/en/x?q=1');
    expect(localeSegment('zh-Hant')).toBe('zh-hant');
  });
});
