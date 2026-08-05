// The RSS feed, derived from the changelog page's own markdown so a release is written once and
// published twice.

import type { Page } from './config';
import { ORIGIN } from './config';
import { escapeHtml, slugify } from './text';

export function feedXml(changelog: Page): string {
  // Sections are split by hand rather than by one regex: `$` under /m would end the
  // capture at the first line break and every description would ship empty.
  const items = changelog.body
    .split(/^## /m)
    .map((section) => /^(.+?) — (\d{4}-\d{2}-\d{2})\n([\s\S]*)$/.exec(section))
    .filter((match): match is RegExpExecArray => match !== null)
    .slice(0, 20)
    .map((match) => {
      const [, version = '', date = '', body = ''] = match;
      const id = slugify(`${version} ${date}`);
      const summary = body
        .split('\n')
        .filter((line) => line.startsWith('- '))
        .map((line) => line.slice(2).replace(/[`*[\]]/g, ''))
        .join(' · ');
      return `    <item>
      <title>${escapeHtml(version)}</title>
      <link>${ORIGIN}/changelog/#${id}</link>
      <guid isPermaLink="false">ultimate-${id}</guid>
      <pubDate>${new Date(`${date}T00:00:00Z`).toUTCString()}</pubDate>
      <description>${escapeHtml(summary)}</description>
    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Ultimate changelog</title>
    <link>${ORIGIN}/changelog/</link>
    <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml" />
    <description>Releases and milestone notes for the Ultimate framework.</description>
    <language>en</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
