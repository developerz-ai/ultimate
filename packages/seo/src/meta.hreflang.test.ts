// The hreflang cluster a route did not write: every routed locale in BCP 47 region form, absolute,
// plus `x-default` naming the default locale's page — and `og:locale` with its alternates.
import { describe, expect, test } from 'bun:test';
import { hreflangTag, ogLocaleTag } from './locale-tags';
import { type HeadTag, renderMeta } from './meta';

const localization = {
  locale: 'en',
  defaultLocale: 'es-co',
  alternates: [
    { locale: 'es-co', path: '/precios' },
    { locale: 'en', path: '/en/precios' },
  ],
};

const links = (tags: readonly HeadTag[]) =>
  tags
    .filter((tag) => tag.tag === 'link' && tag.attrs['rel'] === 'alternate')
    .map((tag) => [tag.attrs['hreflang'], tag.attrs['href']]);

const property = (tags: readonly HeadTag[], name: string) =>
  tags.filter((tag) => tag.attrs['property'] === name).map((tag) => tag.attrs['content']);

describe('automatic hreflang — refusals', () => {
  test('a single-locale app emits no cluster and no og:locale:alternate', () => {
    const tags = renderMeta(
      { title: 'x' },
      {
        baseUrl: 'https://notificado.co',
        path: '/precios',
        localization: {
          locale: 'es-co',
          defaultLocale: 'es-co',
          alternates: [{ locale: 'es-co', path: '/precios' }],
        },
      },
    );
    expect(links(tags)).toEqual([]);
    expect(property(tags, 'og:locale:alternate')).toEqual([]);
    expect(property(tags, 'og:locale')).toEqual(['es_CO']);
  });

  test('a route that declares its own alternates is not second-guessed', () => {
    const tags = renderMeta(
      { title: 'x', alternates: [{ hreflang: 'fr', href: '/fr' }] },
      { baseUrl: 'https://notificado.co', path: '/precios', localization },
    );
    expect(links(tags).map(([hreflang]) => hreflang)).toEqual(['fr', 'x-default']);
  });

  test('a declared og.locale wins over the document locale', () => {
    const tags = renderMeta(
      { title: 'x', og: { locale: 'en_GB' } },
      { path: '/precios', localization },
    );
    expect(property(tags, 'og:locale')).toEqual(['en_GB']);
  });
});

describe('automatic hreflang', () => {
  test('three alternates, absolute, BCP 47 region form, x-default → the default locale', () => {
    const tags = renderMeta(
      { title: 'x' },
      { baseUrl: 'https://notificado.co', path: '/en/precios', localization },
    );
    expect(links(tags)).toEqual([
      ['es-CO', 'https://notificado.co/precios'],
      ['en', 'https://notificado.co/en/precios'],
      ['x-default', 'https://notificado.co/precios'],
    ]);
  });

  test('canonical and og:url are absolute against the base URL', () => {
    const tags = renderMeta(
      { title: 'x' },
      { baseUrl: 'https://notificado.co', path: '/en/precios', localization },
    );
    const canonical = tags.find((tag) => tag.attrs['rel'] === 'canonical');
    expect(canonical?.attrs['href']).toBe('https://notificado.co/en/precios');
    expect(property(tags, 'og:url')).toEqual(['https://notificado.co/en/precios']);
  });

  test('og:locale is the document locale, og:locale:alternate every other one', () => {
    const tags = renderMeta({ title: 'x' }, { path: '/en/precios', localization });
    expect(property(tags, 'og:locale')).toEqual(['en']);
    expect(property(tags, 'og:locale:alternate')).toEqual(['es_CO']);
  });

  test('the tag forms', () => {
    expect(hreflangTag('es-co')).toBe('es-CO');
    expect(hreflangTag('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(hreflangTag('en')).toBe('en');
    expect(hreflangTag('not a tag')).toBe('not a tag');
    expect(ogLocaleTag('pt-br')).toBe('pt_BR');
  });
});
