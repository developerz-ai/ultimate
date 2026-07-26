import { describe, expect, test } from 'bun:test';
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
