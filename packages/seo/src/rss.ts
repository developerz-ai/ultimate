// Feed generation from a route's enumerated items. All three formats come from
// one item list, because a site that ships RSS but not JSON Feed has simply
// picked a winner for its readers.

import { type Clock, systemClock } from '@ultimat3/core';
import { epochOf, isoOf, newestEpoch, nowEpoch, rfc822Of } from './feed-dates';
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

export interface BuildFeedOptions {
  /**
   * Where "now" comes from when no item carries a usable timestamp. Defaults to `systemClock`;
   * pass `frozenClock(at)` and the three formats are byte-for-byte reproducible.
   */
  clock?: Clock;
}

/**
 * An item with its timestamps already resolved, so no builder below ever parses a date. A date the
 * app supplied that will not parse is `undefined` here, and every format omits the element rather
 * than emitting `Invalid Date` — a feed reader is entitled to reject a document over one, and the
 * other twenty entries are fine.
 */
interface DatedItem {
  readonly item: FeedItem;
  readonly published: number | undefined;
  readonly updated: number | undefined;
}

function dated(item: FeedItem): DatedItem {
  return { item, published: epochOf(item.published), updated: epochOf(item.updated) };
}

/**
 * Newest first. An item with no usable `published` sorts last, rather than making the comparator
 * answer `NaN` — which hands the order of the whole feed to the engine's sort implementation.
 */
function byNewest(a: DatedItem, b: DatedItem): number {
  if (a.published === undefined) return b.published === undefined ? 0 : 1;
  if (b.published === undefined) return -1;
  return b.published - a.published;
}

/** Atom's person construct (RFC 4287 §3.2): a name, and whichever of email and uri is known. */
function atomAuthor(author: FeedAuthor): string {
  const email = author.email === undefined ? '' : xmlElement('email', author.email);
  const uri = author.url === undefined ? '' : xmlElement('uri', author.url);
  return `<author>${xmlElement('name', author.name)}${email}${uri}</author>`;
}

/** RSS 2.0's `<author>` IS an e-mail address; a name with none is Dublin Core's `dc:creator`. */
const needsCreator = (author: FeedAuthor | undefined): author is FeedAuthor =>
  author !== undefined && author.email === undefined;

function rssAuthor(author: FeedAuthor): string {
  return author.email === undefined
    ? xmlElement('dc:creator', author.name)
    : xmlElement('author', `${author.email} (${author.name})`);
}

function buildRss(channel: FeedChannel, items: readonly DatedItem[], updated: number): string {
  const self = absoluteUrl(channel.siteUrl, channel.feedUrl);
  // Declared only when used: a namespace on every feed would change bytes no reader asked for.
  const dublinCore = items.some(({ item }) => needsCreator(item.author))
    ? ' xmlns:dc="http://purl.org/dc/elements/1.1/"'
    : '';
  // Media RSS, not `<enclosure>`: RSS 2.0 requires a byte `length` there and nothing here has one.
  const media = items.some(({ item }) => item.image !== undefined)
    ? ' xmlns:media="http://search.yahoo.com/mrss/"'
    : '';
  const entries = items
    .map(({ item, published }) => {
      const parts = [
        xmlElement('title', item.title),
        xmlElement('link', item.url),
        `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
      ];
      if (published !== undefined) parts.push(xmlElement('pubDate', rfc822Of(published)));
      if (item.author !== undefined) parts.push(rssAuthor(item.author));
      if (item.summary !== undefined) parts.push(xmlElement('description', item.summary));
      if (item.contentHtml !== undefined) {
        parts.push(`      <content:encoded>${cdata(item.contentHtml)}</content:encoded>`);
      }
      for (const tag of item.tags ?? []) parts.push(xmlElement('category', tag));
      if (item.image !== undefined) {
        const url = escapeXml(absoluteUrl(channel.siteUrl, item.image));
        parts.push(`      <media:content url="${url}" medium="image"/>`);
      }
      return `    <item>\n${parts.map((line) => (line.startsWith('      ') ? line : `      ${line}`)).join('\n')}\n    </item>`;
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"${dublinCore}${media}>`,
    '  <channel>',
    `    ${xmlElement('title', channel.title)}`,
    `    ${xmlElement('link', channel.siteUrl)}`,
    `    ${xmlElement('description', channel.description)}`,
    `    ${xmlElement('language', channel.language)}`,
    `    ${xmlElement('lastBuildDate', rfc822Of(updated))}`,
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

function buildAtom(channel: FeedChannel, items: readonly DatedItem[], updated: number): string {
  const self = absoluteUrl(channel.siteUrl, channel.feedUrl);
  const entries = items
    .map(({ item, published, updated: itemUpdated }) => {
      const parts = [
        `      ${xmlElement('title', item.title)}`,
        `      <link href="${escapeXml(item.url)}"/>`,
        `      ${xmlElement('id', item.id)}`,
        // Atom requires <updated> on every entry, so an entry with no usable date of its own
        // carries the feed's — the one instant in the document that is always real.
        `      ${xmlElement('updated', isoOf(itemUpdated ?? published ?? updated))}`,
      ];
      if (published !== undefined) {
        parts.push(`      ${xmlElement('published', isoOf(published))}`);
      }
      if (item.summary !== undefined) parts.push(`      ${xmlElement('summary', item.summary)}`);
      if (item.contentHtml !== undefined) {
        parts.push(`      <content type="html">${escapeXml(item.contentHtml)}</content>`);
      }
      if (item.author !== undefined) parts.push(`      ${atomAuthor(item.author)}`);
      for (const tag of item.tags ?? []) {
        parts.push(`      <category term="${escapeXml(tag)}"/>`);
      }
      if (item.image !== undefined) {
        const href = escapeXml(absoluteUrl(channel.siteUrl, item.image));
        parts.push(`      <link rel="enclosure" href="${href}"/>`);
      }
      return `    <entry>\n${parts.join('\n')}\n    </entry>`;
    })
    .join('\n');

  return (
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(channel.language)}">`,
      `  ${xmlElement('title', channel.title)}`,
      `  ${xmlElement('subtitle', channel.description)}`,
      `  ${xmlElement('id', channel.siteUrl)}`,
      `  ${xmlElement('updated', isoOf(updated))}`,
      `  <link href="${escapeXml(channel.siteUrl)}"/>`,
      `  <link href="${escapeXml(self)}" rel="self" type="application/atom+xml"/>`,
      // RFC 4287 §4.1.1: a feed carries an author unless every entry does. The channel's was read
      // by the JSON builder alone, so an Atom feed with authorless entries was not a valid one.
      channel.author === undefined ? '' : `  ${atomAuthor(channel.author)}`,
      channel.copyright === undefined ? '' : `  ${xmlElement('rights', channel.copyright)}`,
      channel.icon === undefined
        ? ''
        : `  ${xmlElement('icon', absoluteUrl(channel.siteUrl, channel.icon))}`,
      entries,
      '</feed>',
      '',
    ]
      // The trailing '' is the document's final newline; only an absent optional line is dropped.
      .filter((line, index, lines) => line !== '' || index === lines.length - 1)
      .join('\n')
  );
}

function buildJsonFeed(channel: FeedChannel, items: readonly DatedItem[]): string {
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
      items: items.map(({ item, published, updated }) => ({
        id: item.id,
        url: item.url,
        title: item.title,
        summary: item.summary,
        content_html: item.contentHtml,
        image: item.image,
        date_published: published === undefined ? undefined : isoOf(published),
        date_modified: updated === undefined ? undefined : isoOf(updated),
        tags: item.tags,
        authors: item.author === undefined ? undefined : [item.author],
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * RSS 2.0, Atom, and JSON Feed 1.1 from one item list. Never throws over a date: an unparseable
 * one is treated as absent, and the feed still renders for the items that have a real one.
 */
export function buildFeed(
  channel: FeedChannel,
  items: readonly FeedItem[],
  options: BuildFeedOptions = {},
): Feed {
  const ordered = items.map(dated).sort(byNewest);
  const updated =
    epochOf(channel.updated) ??
    newestEpoch(ordered.map((entry) => entry.updated ?? entry.published)) ??
    nowEpoch(options.clock ?? systemClock);
  return {
    rss: buildRss(channel, ordered, updated),
    atom: buildAtom(channel, ordered, updated),
    json: buildJsonFeed(channel, ordered),
  };
}
