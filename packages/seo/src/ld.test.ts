import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';
import { ld } from './ld';

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
});

describe('ld.Product offers', () => {
  test('availability is expanded to a schema.org URL, and the other offer fields pass through', () => {
    const node = ld.Product({
      name: 'Ultimate Pro',
      offers: {
        price: '19.99',
        priceCurrency: 'USD',
        availability: 'PreOrder',
        url: 'https://ultimate.dev/buy',
        priceValidUntil: '2026-12-31',
      },
    });
    expect(node['offers']).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Offer',
      price: '19.99',
      priceCurrency: 'USD',
      availability: 'https://schema.org/PreOrder',
      url: 'https://ultimate.dev/buy',
      priceValidUntil: '2026-12-31',
    });
  });

  test('an offer with no availability omits the key rather than emitting undefined', () => {
    const node = ld.Product({
      name: 'Ultimate Pro',
      offers: { price: '1.00', priceCurrency: 'EUR' },
    });
    const offers = node['offers'] as Record<string, unknown>;
    expect('availability' in offers).toBe(false);
    expect('url' in offers).toBe(false);
  });

  test('an empty offer price throws X_LD_INVALID naming Offer.price, not Product.name', () => {
    try {
      ld.Product({ name: 'Ultimate Pro', offers: { price: '  ', priceCurrency: 'USD' } });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string; fix?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('ld.Offer()');
      expect(err.cause).toContain('"price"');
      expect(err.fix).toContain('ld.Offer()');
    }
  });

  test('an empty priceCurrency throws even when the price is present', () => {
    try {
      ld.Product({ name: 'Ultimate Pro', offers: { price: '19.99', priceCurrency: '' } });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('"priceCurrency"');
    }
  });

  test('brand and aggregateRating become their own typed nodes, and are absent when omitted', () => {
    const rated = ld.Product({
      name: 'Ultimate Pro',
      offers: { price: '19.99', priceCurrency: 'USD' },
      brand: 'Developerz',
      aggregateRating: { ratingValue: '4.8', reviewCount: 214 },
    });
    expect(rated['brand']).toEqual({ '@type': 'Brand', name: 'Developerz' });
    expect(rated['aggregateRating']).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.8',
      reviewCount: 214,
    });

    const plain = ld.Product({
      name: 'Ultimate Pro',
      offers: { price: '19.99', priceCurrency: 'USD' },
    });
    expect('aggregateRating' in plain).toBe(false);
    expect('brand' in plain).toBe(false);
  });
});

describe('ld.BreadcrumbList and ld.FAQPage refuse empty lists', () => {
  test('a breadcrumb list with no crumbs throws X_LD_INVALID naming items', () => {
    try {
      ld.BreadcrumbList({ items: [] });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string; fix?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('ld.BreadcrumbList()');
      expect(err.cause).toContain('"items"');
      expect(err.cause).toContain('at least one crumb');
      expect(err.fix).toContain('ld.BreadcrumbList()');
    }
  });

  test('an FAQPage with no questions throws X_LD_INVALID naming questions', () => {
    try {
      ld.FAQPage({ questions: [] });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('ld.FAQPage()');
      expect(err.cause).toContain('"questions"');
    }
  });

  test('FAQPage nests each answer under acceptedAnswer, in order', () => {
    const node = ld.FAQPage({
      questions: [
        { question: 'Is it Bun-only?', answer: 'Yes.' },
        { question: 'Does it ship a CLI?', answer: 'x.' },
      ],
    });
    expect(node['@type']).toBe('FAQPage');
    expect(node['mainEntity']).toEqual([
      {
        '@type': 'Question',
        name: 'Is it Bun-only?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes.' },
      },
      {
        '@type': 'Question',
        name: 'Does it ship a CLI?',
        acceptedAnswer: { '@type': 'Answer', text: 'x.' },
      },
    ]);
  });

  test('a blank answer is refused by field name, not swallowed as an empty answer', () => {
    try {
      ld.FAQPage({ questions: [{ question: 'Is it Bun-only?', answer: '   ' }] });
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain('"questions[].answer"');
    }
  });
});

describe('ld.SoftwareApplication', () => {
  test('carries the three required fields and expands a nested offer', () => {
    const node = ld.SoftwareApplication({
      name: 'Ultimate',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS',
      url: 'https://ultimate.dev',
      offers: { price: '0', priceCurrency: 'USD', availability: 'InStock' },
      aggregateRating: { ratingValue: '4.9', reviewCount: 12 },
    });
    expect(node['@type']).toBe('SoftwareApplication');
    expect(node['applicationCategory']).toBe('DeveloperApplication');
    expect(node['operatingSystem']).toBe('Linux, macOS');
    expect(node['offers']).toMatchObject({
      '@type': 'Offer',
      availability: 'https://schema.org/InStock',
    });
    expect(node['aggregateRating']).toEqual({
      '@type': 'AggregateRating',
      ratingValue: '4.9',
      reviewCount: 12,
    });
  });

  test('omitting the optional offer leaves the key out entirely', () => {
    const node = ld.SoftwareApplication({
      name: 'Ultimate',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux',
    });
    expect('offers' in node).toBe(false);
    expect('aggregateRating' in node).toBe(false);
    expect('url' in node).toBe(false);
  });

  test.each([
    ['name', { name: '', applicationCategory: 'DeveloperApplication', operatingSystem: 'Linux' }],
    [
      'applicationCategory',
      { name: 'Ultimate', applicationCategory: ' ', operatingSystem: 'Linux' },
    ],
    ['operatingSystem', { name: 'Ultimate', applicationCategory: 'App', operatingSystem: '' }],
  ] as const)('an empty %s is refused by name', (field, input) => {
    try {
      ld.SoftwareApplication(input);
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; cause?: string };
      expect(err.code).toBe(SEO_ERROR_CODES.ldInvalid);
      expect(err.cause).toContain(`"${field}"`);
      expect(err.cause).toContain('ld.SoftwareApplication()');
    }
  });
});

describe('ld.Event offers', () => {
  test('an in-person event with an offer carries a Place and the expanded offer', () => {
    const node = ld.Event({
      name: 'Launch',
      startDate: '2026-09-01T17:00:00Z',
      location: 'Bucharest',
      offers: { price: '0', priceCurrency: 'RON' },
    });
    expect(node['location']).toEqual({ '@type': 'Place', name: 'Bucharest' });
    expect(node['eventAttendanceMode']).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(node['offers']).toMatchObject({ '@type': 'Offer', price: '0', priceCurrency: 'RON' });
  });

  test('an explicit attendanceMode overrides the one inferred from the location', () => {
    const node = ld.Event({
      name: 'Launch',
      startDate: '2026-09-01T17:00:00Z',
      location: 'https://ultimate.dev/live',
      eventAttendanceMode: 'Mixed',
    });
    expect(node['eventAttendanceMode']).toBe('https://schema.org/MixedEventAttendanceMode');
  });
});
