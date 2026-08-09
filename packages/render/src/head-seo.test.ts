import { describe, expect, test } from 'bun:test';
import { ld } from '@ultimat3/seo';
import { headFromMeta, renderHead } from './head';
import { headTagKey, seoRenderers, toHeadTag } from './head-seo';

describe('seoRenderers', () => {
  test('renders a real head from a route meta', () => {
    const tags = headFromMeta(
      { title: 'Pricing', description: 'Plans and prices', canonical: '/pricing' },
      seoRenderers(),
    );
    const html = renderHead(tags);
    expect(html).toContain('<title>Pricing</title>');
    expect(html).toContain('<meta name="description" content="Plans and prices">');
    expect(html).toContain('<link rel="canonical" href="/pricing">');
  });

  test('keeps every JSON-LD node — identical attrs must not dedupe to the last one', () => {
    const tags = seoRenderers().renderMeta({
      title: 'Home',
      ld: [
        ld.WebSite({ name: 'A', url: 'https://a.test' }),
        ld.WebSite({ name: 'B', url: 'https://b.test' }),
      ],
    });
    const scripts = tags.filter((tag) => tag.kind === 'script');
    expect(scripts).toHaveLength(2);
    expect(new Set(scripts.map((tag) => tag.key)).size).toBe(2);
    expect(renderHead(tags)).toContain('"name":"B"');
  });

  test('dedupes by identity: a later override of one meta wins, the rest survive', () => {
    const base = seoRenderers().renderMeta({ title: 'Home', description: 'first' });
    const merged = headFromMeta({ title: 'Home', description: 'first' }, seoRenderers(), [
      { kind: 'meta', key: 'meta:description', attrs: { name: 'description', content: 'second' } },
    ]);
    expect(base.length).toBe(merged.length);
    const description = merged.find((tag) => tag.key === 'meta:description');
    expect(description?.attrs?.['content']).toBe('second');
    expect(merged.filter((tag) => tag.key === 'meta:description')).toHaveLength(1);
  });

  test('theme-color entries key apart by media query', () => {
    const tags = seoRenderers().renderMeta({
      title: 'Home',
      themeColor: [
        { color: 'var(--x-bg)', scheme: 'light' },
        { color: 'var(--x-bg-dark)', scheme: 'dark' },
      ],
    });
    const themed = tags.filter((tag) => tag.key.startsWith('meta:theme-color'));
    expect(themed).toHaveLength(2);
  });

  test('headTagKey and toHeadTag translate the vocabulary, not the content', () => {
    const seoTag = { tag: 'meta', attrs: { property: 'og:title', content: 'Hi' } } as const;
    expect(headTagKey(seoTag, 0)).toBe('meta:og:title');
    expect(toHeadTag(seoTag, 0)).toEqual({
      kind: 'meta',
      key: 'meta:og:title',
      attrs: { property: 'og:title', content: 'Hi' },
    });
  });

  test('baseUrl absolutises the canonical it is given', () => {
    const tags = seoRenderers({ baseUrl: 'https://postly.test' }).renderMeta({
      title: 'Home',
      canonical: '/pricing',
    });
    expect(renderHead(tags)).toContain('href="https://postly.test/pricing"');
  });
});
