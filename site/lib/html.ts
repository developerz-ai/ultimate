// The page fragments the layout and doc templates slot in: header nav, table of contents,
// previous/next pager, and the JSON-LD graph.

import type { Page } from './config';
import { ORIGIN } from './config';
import { inline } from './markdown';
import { escapeHtml } from './text';

export function navHtml(pages: readonly Page[], current: Page): string {
  return (
    pages
      // `menu: true` opts a page into the header; every page is still reachable from the
      // footer and the pager, so the header never has to grow a scroll region on desktop.
      .filter((page) => page.meta.menu === 'true')
      .map((page) => {
        const active = page.slug === current.slug ? ' aria-current="page"' : '';
        return `              <li><a href="${page.url}"${active}>${escapeHtml(page.meta.nav ?? '')}</a></li>`;
      })
      .join('\n')
  );
}

export function tocHtml(headings: readonly { id: string; text: string }[]): string {
  if (headings.length === 0) return '';
  const items = headings
    .map((h) => `      <li><a href="#${h.id}">${inline(h.text)}</a></li>`)
    .join('\n');
  return `    <ol>\n${items}\n    </ol>`;
}

export function pagerHtml(pages: readonly Page[], index: number): string {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  if (previous === undefined && next === undefined) return '';
  const left =
    previous === undefined
      ? '<span></span>'
      : `<a href="${previous.url}"><span>Previous</span><strong>${escapeHtml(previous.meta.nav ?? previous.slug)}</strong></a>`;
  const right =
    next === undefined
      ? '<span></span>'
      : `<a class="pager--next" href="${next.url}"><span>Next</span><strong>${escapeHtml(next.meta.nav ?? next.slug)}</strong></a>`;
  return `    <nav class="pager" aria-label="Page navigation">${left}${right}</nav>`;
}

export function jsonLd(page: Page, isHome: boolean): string {
  const graph = isHome
    ? {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'Ultimate',
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Web framework',
        operatingSystem: 'Linux, macOS',
        description: page.meta.description,
        url: `${ORIGIN}/`,
        softwareVersion: '0.0.1',
        license: 'https://opensource.org/licenses/MIT',
        codeRepository: 'https://github.com/developerz-ai/ultimate',
        runtimePlatform: 'Bun >= 1.3',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        author: { '@type': 'Organization', name: 'developerz-ai' },
      }
    : {
        '@context': 'https://schema.org',
        '@type': 'TechArticle',
        headline: page.meta.title,
        description: page.meta.description,
        url: `${ORIGIN}${page.url}`,
        dateModified: page.meta.updated,
        inLanguage: 'en',
        isPartOf: { '@type': 'WebSite', name: 'Ultimate', url: `${ORIGIN}/` },
        author: { '@type': 'Organization', name: 'developerz-ai' },
        proficiencyLevel: 'Expert',
      };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Ultimate', item: `${ORIGIN}/` },
      ...(isHome
        ? []
        : [
            {
              '@type': 'ListItem',
              position: 2,
              name: page.meta.title,
              item: `${ORIGIN}${page.url}`,
            },
          ]),
    ],
  };
  return [graph, crumbs]
    .map(
      (data) =>
        // `<` is escaped so no value can close the script element early.
        `    <script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`,
    )
    .join('\n');
}
