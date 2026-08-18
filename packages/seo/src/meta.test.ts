import { describe, expect, test } from 'bun:test';
import * as seo from './index';
import { applyTitleTemplate, hreflangSet, type RouteMeta, renderMeta } from './meta';

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
  alternates: [
    { hreflang: 'en', href: '/blog/ship-it' },
    { hreflang: 'es', href: '/es/blog/ship-it' },
  ],
  themeColor: [
    { color: 'rgb(253 246 240)', scheme: 'light' },
    { color: 'rgb(18 18 20)', scheme: 'dark' },
  ],
};

function find(
  tags: readonly { tag: string; attrs: Record<string, string> }[],
  attr: string,
  value: string,
) {
  return tags.filter((tag) => tag.attrs[attr] === value);
}

describe('exported length bounds', () => {
  test('every exported bound is one validateMeta actually enforces', () => {
    // `DESCRIPTION_MIN_LENGTH` sat under the comment "validate.ts enforces it" and no validator
    // ever read it, so a 10-character description passed a gate the constant said it would fail.
    // A bound that ships without an enforcer is a promise, and a promise is not a build error.
    const bounds = Object.keys(seo)
      .filter((name) => name.endsWith('_LENGTH'))
      .sort();

    expect(bounds).toEqual(['DESCRIPTION_MAX_LENGTH', 'TITLE_MAX_LENGTH']);
  });
});

describe('renderMeta', () => {
  test('applies the title template without doubling the brand', () => {
    expect(applyTitleTemplate('Ship it', '%s — Ultimate')).toBe('Ship it — Ultimate');
    expect(applyTitleTemplate('Ultimate', '%s — Ultimate')).toBe('Ultimate');
  });

  // The containment was inverted — `template.includes(title)` only ever answers true for the
  // exact-equality case above, so every title that MENTIONS the brand got it a second time and
  // `validate.ts` then measured the doubled string against TITLE_MAX_LENGTH.
  test('a title that already contains the brand is left alone, not just one that equals it', () => {
    expect(applyTitleTemplate('About Ultimate', '%s — Ultimate')).toBe('About Ultimate');
    expect(applyTitleTemplate('Ultimate for teams', '%s — Ultimate')).toBe('Ultimate for teams');
    expect(applyTitleTemplate('Why we built Ultimate', '%s | Ultimate')).toBe(
      'Why we built Ultimate',
    );
  });

  test('a title that only shares a word with the template is still branded', () => {
    expect(applyTitleTemplate('Ship it', '%s | Ultimate')).toBe('Ship it | Ultimate');
    expect(applyTitleTemplate('Pricing', '%s — Ultimate')).toBe('Pricing — Ultimate');
  });

  test('absolutises canonical, og:url and alternates against the base URL', () => {
    const tags = renderMeta(META, { baseUrl: 'https://ultimate.dev' });
    const canonical = tags.find((tag) => tag.attrs['rel'] === 'canonical');
    expect(canonical?.attrs['href']).toBe('https://ultimate.dev/blog/ship-it');
    expect(find(tags, 'property', 'og:url')[0]?.attrs['content']).toBe(
      'https://ultimate.dev/blog/ship-it',
    );
  });

  test('the hreflang set always includes x-default', () => {
    const tags = renderMeta(META, { baseUrl: 'https://ultimate.dev' });
    const alternates = tags.filter((tag) => tag.attrs['rel'] === 'alternate');
    expect(alternates.map((tag) => tag.attrs['hreflang'])).toEqual(['en', 'es', 'x-default']);
    expect(alternates[2]?.attrs['href']).toBe('https://ultimate.dev/blog/ship-it');
  });

  test('an existing x-default is not duplicated', () => {
    const set = hreflangSet(
      [
        { hreflang: 'en', href: '/a' },
        { hreflang: 'x-default', href: '/a' },
      ],
      '/fallback',
    );
    expect(set).toHaveLength(2);
    expect(set.filter((entry) => entry.hreflang === 'x-default')).toHaveLength(1);
  });

  test('theme-color is emitted per colour scheme', () => {
    const tags = renderMeta(META);
    const themeColors = find(tags, 'name', 'theme-color');
    expect(themeColors).toHaveLength(2);
    expect(themeColors[0]?.attrs['media']).toBe('(prefers-color-scheme: light)');
    expect(themeColors[1]?.attrs['media']).toBe('(prefers-color-scheme: dark)');
  });

  test('og:image with dimensions upgrades the twitter card automatically', () => {
    const tags = renderMeta(META);
    expect(find(tags, 'name', 'twitter:card')[0]?.attrs['content']).toBe('summary_large_image');
    expect(find(tags, 'property', 'og:image:width')[0]?.attrs['content']).toBe('1200');
  });

  test('robots defaults to index,follow and honours directives', () => {
    expect(find(renderMeta(META), 'name', 'robots')[0]?.attrs['content']).toBe('index,follow');
    const noindex = renderMeta({ ...META, robots: { index: false, maxImagePreview: 'large' } });
    expect(find(noindex, 'name', 'robots')[0]?.attrs['content']).toBe(
      'noindex,follow,max-image-preview:large',
    );
  });

  /**
   * This package CONSTRUCTS head tags and serialises none of them: `renderHeadTags` used to live
   * here, was called by nothing, and escaped `</` only — so the one path that existed was weaker
   * than the one every document actually takes (`@ultimat3/render`'s `renderHead`). What survives
   * the deletion is the contract between the two, which is entirely in the DATA:
   *
   * - `text` is the raw JSON, unescaped, because escaping belongs to whoever emits the element;
   * - `attrs.type` ends in `json`, which is the flag render's `carriesJson` keys the total JSON
   *   escape off. Spell that attribute differently and render silently downgrades a JSON body to
   *   the rule for executable code — no test would fail, and `meta.ld` is built from route data.
   */
  test('an ld node is emitted as DATA: raw JSON under a ld+json type, escaped by nobody here', () => {
    const injected = '</script><img src=x onerror=alert(1)>';
    const tags = renderMeta({ title: 'A & B', ld: [{ '@type': 'Thing', name: injected }] });

    const script = tags.filter((tag) => tag.tag === 'script');
    expect(script).toHaveLength(1);
    expect(script[0]?.attrs['type']).toBe('application/ld+json');
    expect(script[0]?.attrs['type']?.endsWith('json')).toBe(true);
    // Verbatim, and still parseable as the object it came from.
    expect(script[0]?.text).toBe(JSON.stringify({ '@type': 'Thing', name: injected }));

    // The title is data too — `&` is not entity-escaped until something renders it.
    expect(tags.find((tag) => tag.tag === 'title')?.text).toBe('A & B');
  });
});
