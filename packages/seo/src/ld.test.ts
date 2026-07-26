import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import { ld, renderLd } from './ld';

describe('ld builders', () => {
  test('Article requires datePublished at the type level', () => {
    // @ts-expect-error - datePublished is required by schema.org for Article
    const bad = () => ld.Article({ headline: 'Ship it', author: { name: 'Ada' } });
    expect(typeof bad).toBe('function');
  });

  test('Article produces a valid node and defaults dateModified', () => {
    const node = ld.Article({
      headline: 'Ship it',
      datePublished: '2026-07-26',
      author: { name: 'Ada Lovelace', url: 'https://ultimate.dev/ada' },
    });
    expect(node['@context']).toBe('https://schema.org');
    expect(node['@type']).toBe('Article');
    expect(node['dateModified']).toBe('2026-07-26');
    expect(node['author']).toMatchObject({ '@type': 'Person', name: 'Ada Lovelace' });
  });

  test('an Organization author is not rendered as a Person', () => {
    const node = ld.Article({
      headline: 'Ship it',
      datePublished: '2026-07-26',
      author: { type: 'Organization', name: 'Developerz', url: 'https://developerz.ai' },
    });
    expect(node['author']).toMatchObject({ '@type': 'Organization', name: 'Developerz' });
  });

  test('an empty required string throws X_LD_INVALID naming the field', () => {
    try {
      ld.Product({ name: '', offers: { price: '19.99', priceCurrency: 'USD' } });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string; fix?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('"name"');
      expect(err.fix).toContain('ld.Product()');
    }
  });

  test('BreadcrumbList numbers its positions from 1', () => {
    const node = ld.BreadcrumbList({
      items: [
        { name: 'Home', url: 'https://ultimate.dev/' },
        { name: 'Blog', url: 'https://ultimate.dev/blog' },
      ],
    });
    expect(node['itemListElement']).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://ultimate.dev/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: 'https://ultimate.dev/blog' },
    ]);
  });

  test('WebSite emits a SearchAction only when a template is given', () => {
    const plain = ld.WebSite({ name: 'Ultimate', url: 'https://ultimate.dev' });
    expect(plain['potentialAction']).toBeUndefined();
    const searchable = ld.WebSite({
      name: 'Ultimate',
      url: 'https://ultimate.dev',
      searchUrlTemplate: 'https://ultimate.dev/search?q={search_term_string}',
    });
    expect(searchable['potentialAction']).toMatchObject({ '@type': 'SearchAction' });
  });

  test('Event picks the online attendance mode from a URL location', () => {
    const node = ld.Event({
      name: 'Launch',
      startDate: '2026-09-01T17:00:00Z',
      location: 'https://ultimate.dev/live',
    });
    expect(node['location']).toMatchObject({ '@type': 'VirtualLocation' });
    expect(node['eventAttendanceMode']).toBe('https://schema.org/OnlineEventAttendanceMode');
  });

  test('renderLd collapses several nodes into one @graph script', () => {
    const tag = renderLd([
      ld.WebSite({ name: 'Ultimate', url: 'https://ultimate.dev' }),
      ld.Organization({ name: 'Developerz', url: 'https://developerz.ai' }),
    ]);
    expect(tag.attrs['type']).toBe('application/ld+json');
    const parsed = JSON.parse(tag.text ?? '{}') as { '@graph': unknown[] };
    expect(parsed['@graph']).toHaveLength(2);
    expect(JSON.stringify(parsed['@graph'])).not.toContain('@context');
  });
});
