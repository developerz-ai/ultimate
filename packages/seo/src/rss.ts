// Feed generation from a route's enumerated items. All three formats come from
// one item list, because a site that ships RSS but not JSON Feed has simply
// picked a winner for its readers.

import { absoluteUrl, cdata, escapeXml, xmlElement } from './xml';

export interface FeedAuthor {
  name: string;
  email?: string;
  url?: string;
}

export interface FeedItem {
  /** Stable, permanent identifier. The canonical URL is a fine choice. */
  id: string;
  url: string;
  title: string;
  /** ISO 8601. */
  published: string;
  updated?: string;
  summary?: string;
  /** Full HTML body. Emitted as CDATA in RSS, escaped in Atom. */
  contentHtml?: string;
  author?: FeedAuthor;
  tags?: readonly string[];
  image?: string;
}

export interface FeedChannel {
  title: string;
  description: string;
  /** Absolute site root. */
  siteUrl: string;
  /** Path or absolute URL of the feed itself. */
  feedUrl: string;
  /** BCP-47. */
  language: string;
  /** Defaults to the newest item's timestamp. */
  updated?: string;
  author?: FeedAuthor;
  copyright?: string;
  icon?: string;
}

export interface Feed {
  readonly rss: string;
  readonly atom: string;
  readonly json: string;
}

function newest(items: readonly FeedItem[]): string {
  const times = items.map((item) => Date.parse(item.updated ?? item.published));
  const max = times.length === 0 ? Date.now() : Math.max(...times);
  return new Date(max).toISOString();
}

function rfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

function buildRss(channel: FeedChannel, items: readonly FeedItem[], updated: string): string {
  const self = absoluteUrl(channel.siteUrl, channel.feedUrl);
  const entries = items
    .map((item) => {
      const parts = [
        xmlElement('title', item.title),
        xmlElement('link', item.url),
        `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
        xmlElement('pubDate', rfc822(item.published)),
      ];
      if (item.summary !== undefined) parts.push(xmlElement('description', item.summary));
      if (item.contentHtml !== undefined) {
        parts.push(`      <content:encoded>${cdata(item.contentHtml)}</content:encoded>`);
      }
      for (const tag of item.tags ?? []) parts.push(xmlElement('category', tag));
      return `    <item>\n${parts.map((line) => (line.startsWith('      ') ? line : `      ${line}`)).join('\n')}\n    </item>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">',
    '  <channel>',
    `    ${xmlElement('title', channel.title)}`,
    `    ${xmlElement('link', channel.siteUrl)}`,
    `    ${xmlElement('description', channel.description)}`,
    `    ${xmlElement('language', channel.language)}`,
    `    ${xmlElement('lastBuildDate', rfc822(updated))}`,
    `    <atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>`,
    channel.copyright === undefined ? '' : `    ${xmlElement('copyright', channel.copyright)}`,
    entries,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function buildAtom(channel: FeedChannel, items: readonly FeedItem[], updated: string): string {
  const self = absoluteUrl(channel.siteUrl, channel.feedUrl);
  const entries = items
    .map((item) => {
      const parts = [
        `      ${xmlElement('title', item.title)}`,
        `      <link href="${escapeXml(item.url)}"/>`,
        `      ${xmlElement('id', item.id)}`,
        `      ${xmlElement('updated', item.updated ?? item.published)}`,
        `      ${xmlElement('published', item.published)}`,
      ];
      if (item.summary !== undefined) parts.push(`      ${xmlElement('summary', item.summary)}`);
      if (item.contentHtml !== undefined) {
        parts.push(`      <content type="html">${escapeXml(item.contentHtml)}</content>`);
      }
      if (item.author !== undefined) {
        parts.push(`      <author>${xmlElement('name', item.author.name)}</author>`);
      }
      for (const tag of item.tags ?? []) {
        parts.push(`      <category term="${escapeXml(tag)}"/>`);
      }
      return `    <entry>\n${parts.join('\n')}\n    </entry>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(channel.language)}">`,
    `  ${xmlElement('title', channel.title)}`,
    `  ${xmlElement('subtitle', channel.description)}`,
    `  ${xmlElement('id', channel.siteUrl)}`,
    `  ${xmlElement('updated', updated)}`,
    `  <link href="${escapeXml(channel.siteUrl)}"/>`,
    `  <link href="${escapeXml(self)}" rel="self" type="application/atom+xml"/>`,
    entries,
    '</feed>',
    '',
  ].join('\n');
}

function buildJsonFeed(channel: FeedChannel, items: readonly FeedItem[]): string {
  return `${JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: channel.title,
      description: channel.description,
      home_page_url: channel.siteUrl,
      feed_url: absoluteUrl(channel.siteUrl, channel.feedUrl),
      language: channel.language,
      icon: channel.icon,
      authors: channel.author === undefined ? undefined : [channel.author],
      items: items.map((item) => ({
        id: item.id,
        url: item.url,
        title: item.title,
        summary: item.summary,
        content_html: item.contentHtml,
        image: item.image,
        date_published: item.published,
        date_modified: item.updated,
        tags: item.tags,
        authors: item.author === undefined ? undefined : [item.author],
      })),
    },
    null,
    2,
  )}\n`;
}

/** RSS 2.0, Atom, and JSON Feed 1.1 from one item list. */
export function buildFeed(channel: FeedChannel, items: readonly FeedItem[]): Feed {
  const ordered = [...items].sort((a, b) => Date.parse(b.published) - Date.parse(a.published));
  const updated = channel.updated ?? newest(ordered);
  return {
    rss: buildRss(channel, ordered, updated),
    atom: buildAtom(channel, ordered, updated),
    json: buildJsonFeed(channel, ordered),
  };
}
