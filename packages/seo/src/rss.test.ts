import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { buildFeed, type FeedChannel, type FeedItem } from './rss';

const CHANNEL: FeedChannel = {
  title: 'Ultimate blog',
  description: 'Notes on shipping',
  siteUrl: 'https://ultimate.dev',
  feedUrl: '/blog/feed.xml',
  language: 'en',
};

const ITEMS: FeedItem[] = [
  {
    id: 'https://ultimate.dev/blog/older',
    url: 'https://ultimate.dev/blog/older',
    title: 'Older & wiser',
    published: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'https://ultimate.dev/blog/newer',
    url: 'https://ultimate.dev/blog/newer',
    title: 'Newer',
    published: '2026-07-01T00:00:00.000Z',
    contentHtml: '<p>Body</p>',
    tags: ['release'],
  },
];

describe('buildFeed', () => {
  test('emits all three formats newest-first', () => {
    const feed = buildFeed(CHANNEL, ITEMS);
    expect(feed.rss.indexOf('Newer')).toBeLessThan(feed.rss.indexOf('Older'));
    const json = JSON.parse(feed.json) as { items: Array<{ title: string }> };
    expect(json.items.map((item) => item.title)).toEqual(['Newer', 'Older & wiser']);
  });

  test('escapes XML in RSS and Atom but not in JSON Feed', () => {
    const feed = buildFeed(CHANNEL, ITEMS);
    expect(feed.rss).toContain('Older &amp; wiser');
    expect(feed.atom).toContain('Older &amp; wiser');
    expect(JSON.parse(feed.json)).toMatchObject({ version: 'https://jsonfeed.org/version/1.1' });
  });

  test('HTML content is CDATA in RSS and escaped in Atom', () => {
    const feed = buildFeed(CHANNEL, ITEMS);
    expect(feed.rss).toContain('<![CDATA[<p>Body</p>]]>');
    expect(feed.atom).toContain('&lt;p&gt;Body&lt;/p&gt;');
  });

  test('the self link is absolute in every format', () => {
    const feed = buildFeed(CHANNEL, ITEMS);
    expect(feed.rss).toContain('https://ultimate.dev/blog/feed.xml');
    expect(feed.atom).toContain('https://ultimate.dev/blog/feed.xml');
    expect(JSON.parse(feed.json)).toMatchObject({
      feed_url: 'https://ultimate.dev/blog/feed.xml',
    });
  });
});

/** A row whose date column holds prose — the shape a CMS actually hands a feed route. */
const UNDATED: FeedItem = {
  id: 'https://ultimate.dev/blog/undated',
  url: 'https://ultimate.dev/blog/undated',
  title: 'Undated',
  published: 'sometime last spring',
};

describe('buildFeed dates', () => {
  test('one item whose date will not parse still renders the whole feed', () => {
    const feed = buildFeed(CHANNEL, [...ITEMS, UNDATED]);
    for (const document of [feed.rss, feed.atom, feed.json]) {
      expect(document).toContain('Undated');
      expect(document).toContain('Newer');
      expect(document).not.toContain('Invalid Date');
      expect(document).not.toContain('NaN');
    }
    expect(() => JSON.parse(feed.json)).not.toThrow();
  });

  test('an unusable date is omitted, never invented', () => {
    const feed = buildFeed(CHANNEL, [UNDATED]);
    expect(feed.rss).not.toContain('<pubDate>');
    expect(feed.atom).not.toContain('<published>');
    const json = JSON.parse(feed.json) as { items: Array<Record<string, unknown>> };
    expect(json.items[0]).not.toHaveProperty('date_published');
    // Only the date is dropped — the item itself is still in the feed, whole.
    expect(feed.rss).toContain(
      '<guid isPermaLink="false">https://ultimate.dev/blog/undated</guid>',
    );
  });

  test("an entry with no date of its own carries the feed's, which Atom requires", () => {
    const atom = buildFeed(CHANNEL, [...ITEMS, UNDATED]).atom;
    expect(atom.match(/<updated>/g)).toHaveLength(4); // the feed, then all three entries
    expect(atom.match(/<updated>2026-07-01T00:00:00\.000Z<\/updated>/g)).toHaveLength(3);
  });

  test('an item with no usable date sorts last instead of scrambling the order', () => {
    const feed = buildFeed(CHANNEL, [UNDATED, ...ITEMS]);
    const json = JSON.parse(feed.json) as { items: Array<{ title: string }> };
    expect(json.items.map((item) => item.title)).toEqual(['Newer', 'Older & wiser', 'Undated']);
  });

  test('the feed timestamp is the newest date that parsed', () => {
    const rss = buildFeed(CHANNEL, [...ITEMS, UNDATED]).rss;
    expect(rss).toContain('<lastBuildDate>Wed, 01 Jul 2026 00:00:00 GMT</lastBuildDate>');
  });

  test('a channel timestamp that will not parse falls back to the items', () => {
    const feed = buildFeed({ ...CHANNEL, updated: 'whenever' }, ITEMS);
    expect(feed.rss).toContain('<lastBuildDate>Wed, 01 Jul 2026 00:00:00 GMT</lastBuildDate>');
    expect(feed.atom).toContain('<updated>2026-07-01T00:00:00.000Z</updated>');
  });

  test('with no usable timestamp anywhere the clock supplies one', () => {
    const clock = frozenClock('2026-03-04T05:06:07.000Z');
    const feed = buildFeed(CHANNEL, [UNDATED], { clock });
    expect(feed.rss).toContain('<lastBuildDate>Wed, 04 Mar 2026 05:06:07 GMT</lastBuildDate>');
    expect(feed.atom).toContain('<updated>2026-03-04T05:06:07.000Z</updated>');
  });

  test('an empty feed takes its timestamp from the clock too', () => {
    const feed = buildFeed(CHANNEL, [], { clock: frozenClock('2026-03-04T05:06:07.000Z') });
    expect(feed.atom).toContain('<updated>2026-03-04T05:06:07.000Z</updated>');
  });

  test('the default clock is the system clock', () => {
    // Under the harness that is the frozen instant, which is the point: the default is a seam and
    // not a `Date.now()` buried in the builder where no test could reach it.
    expect(buildFeed(CHANNEL, []).atom).toContain(`<updated>${new Date().toISOString()}</updated>`);
  });

  test('an offset timestamp is the same instant in all three formats', () => {
    const item: FeedItem = {
      id: 'https://ultimate.dev/blog/offset',
      url: 'https://ultimate.dev/blog/offset',
      title: 'Offset',
      published: '2026-07-01T02:00:00+02:00',
    };
    const feed = buildFeed(CHANNEL, [item]);
    expect(feed.rss).toContain('<pubDate>Wed, 01 Jul 2026 00:00:00 GMT</pubDate>');
    expect(feed.atom).toContain('<published>2026-07-01T00:00:00.000Z</published>');
    expect(JSON.parse(feed.json)).toMatchObject({
      items: [{ date_published: '2026-07-01T00:00:00.000Z' }],
    });
  });
});
