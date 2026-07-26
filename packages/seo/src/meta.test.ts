import { describe, expect, test } from 'bun:test';
import {
  applyTitleTemplate,
  hreflangSet,
  type RouteMeta,
  renderHeadTags,
  renderMeta,
} from './meta';

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

describe('renderMeta', () => {
  test('applies the title template without doubling the brand', () => {
    expect(applyTitleTemplate('Ship it', '%s — Ultimate')).toBe('Ship it — Ultimate');
    expect(applyTitleTemplate('Ultimate', '%s — Ultimate')).toBe('Ultimate');
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

  test('renderHeadTags escapes text and neutralises a </script> break-out', () => {
    const html = renderHeadTags(
      renderMeta({ title: 'A & B', ld: [{ '@type': 'Thing', name: '</script><img>' }] }),
    );
    expect(html).toContain('<title>A &amp; B</title>');
    expect(html).not.toContain('</script><img>');
    expect(html).toContain('<\\/script>');
  });
});
