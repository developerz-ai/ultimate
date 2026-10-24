// The social card a link preview is built from: `og:*`, `article:*`, `twitter:*`. One rule and one
// switch — a document that may not be indexed carries no card unless the route declares
// `socialCard: true`, and that field never touches the robots directives.

import { describe, expect, test } from 'bun:test';
import { type HeadTag, type RouteMeta, renderMeta } from './meta';

const META: RouteMeta = {
  title: 'Ship it',
  titleTemplate: '%s — Ultimate',
  description: 'How Ultimate makes the static path the one everyone eats first.',
  canonical: '/blog/ship-it',
  og: {
    type: 'article',
    image: { url: '/og/ship-it.png', width: 1200, height: 630 },
    publishedTime: '2026-07-26',
  },
  twitter: { site: '@ultimate', image: '/og/ship-it.png' },
  alternates: [
    { hreflang: 'en', href: '/blog/ship-it' },
    { hreflang: 'es', href: '/es/blog/ship-it' },
  ],
};

const LOCALIZATION = {
  locale: 'en',
  defaultLocale: 'en',
  alternates: [
    { locale: 'en', path: '/blog/ship-it' },
    { locale: 'es', path: '/es/blog/ship-it' },
  ],
};

function find(tags: readonly HeadTag[], attr: string, value: string) {
  return tags.filter((tag) => tag.attrs[attr] === value);
}

/** The card, whichever half declares it: `og:*`, `article:*` and `twitter:*` are one unit. */
function card(tags: readonly HeadTag[]) {
  return tags.filter((tag) =>
    /^(?:og|article|twitter):/.test(tag.attrs['property'] ?? tag.attrs['name'] ?? ''),
  );
}

describe('the social card', () => {
  test('a noindex route that opts in carries its card, declared and derived', () => {
    const tags = renderMeta(
      { ...META, robots: { index: false }, socialCard: true },
      { baseUrl: 'https://ultimate.dev', localization: LOCALIZATION },
    );

    // Declared values win.
    expect(find(tags, 'name', 'twitter:site')[0]?.attrs['content']).toBe('@ultimate');
    expect(find(tags, 'property', 'og:type')[0]?.attrs['content']).toBe('article');
    expect(find(tags, 'property', 'og:image:width')[0]?.attrs['content']).toBe('1200');
    expect(find(tags, 'property', 'article:published_time')[0]?.attrs['content']).toBe(
      '2026-07-26',
    );
    // The derived ones come with it.
    expect(find(tags, 'property', 'og:title')[0]?.attrs['content']).toBe('Ship it');
    expect(find(tags, 'property', 'og:description')[0]?.attrs['content']).toBe(META.description);
    expect(find(tags, 'property', 'og:url')[0]?.attrs['content']).toBe(
      'https://ultimate.dev/blog/ship-it',
    );
    expect(find(tags, 'property', 'og:locale')[0]?.attrs['content']).toBe('en');
    expect(find(tags, 'name', 'twitter:card')[0]?.attrs['content']).toBe('summary_large_image');
    expect(find(tags, 'name', 'twitter:title')[0]?.attrs['content']).toBe('Ship it');
    // The card is one unit — a half-card is not a preview.
    expect(card(tags).length).toBeGreaterThan(0);
  });

  test('the opt-in never touches the robots line, the canonical or the hreflang cluster', () => {
    const tags = renderMeta(
      { ...META, robots: { index: false }, socialCard: true },
      { baseUrl: 'https://ultimate.dev', localization: LOCALIZATION },
    );

    expect(find(tags, 'name', 'robots')[0]?.attrs['content']).toBe('noindex,follow');
    expect(find(tags, 'rel', 'canonical')).toHaveLength(1);
    expect(find(tags, 'rel', 'canonical')[0]?.attrs['href']).toBe(
      'https://ultimate.dev/blog/ship-it',
    );
    expect(find(tags, 'rel', 'alternate').length).toBeGreaterThan(0);
  });

  test('a document that is not indexed carries no social tags, declared or derived', () => {
    const tags = renderMeta(
      { ...META, robots: { index: false } },
      { baseUrl: 'https://ultimate.dev', localization: LOCALIZATION },
    );

    expect(card(tags)).toEqual([]);
    // Everything that is not a card survives: the page still has a title, a robots line, its
    // canonical and its hreflang cluster.
    expect(tags.some((tag) => tag.tag === 'title')).toBe(true);
    expect(find(tags, 'name', 'robots')[0]?.attrs['content']).toBe('noindex,follow');
    expect(find(tags, 'rel', 'canonical')).toHaveLength(1);
    expect(find(tags, 'rel', 'alternate').length).toBeGreaterThan(0);
  });

  test('an indexable route keeps its card, and the switch is inert there', () => {
    const opted = renderMeta({ ...META, socialCard: true });
    const plain = renderMeta(META);

    expect(find(plain, 'property', 'og:title')).toHaveLength(1);
    expect(find(plain, 'name', 'twitter:card')).toHaveLength(1);
    // The switch changes nothing on a document that keeps its card anyway.
    expect(opted).toEqual(plain);
  });

  test('`follow: false` alone keeps the card: only `index: false` withdraws it', () => {
    const tags = renderMeta({ ...META, robots: { follow: false } });
    expect(find(tags, 'property', 'og:title')).toHaveLength(1);
    expect(find(tags, 'name', 'twitter:card')).toHaveLength(1);
  });
});
