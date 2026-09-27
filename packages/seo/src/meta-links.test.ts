// `RouteMeta.links` — the one way a route puts a `<link>` in `<head>` beyond canonical and hreflang:
// a font preload, a preconnect, a feed. notificado.co had to put its font preload in `<body>`,
// where it is discovered after the stylesheet it exists to race. Pins the render, the order, and
// the refusal of an href that is script rather than a URL.

import { describe, expect, test } from 'bun:test';
import { renderMeta } from './meta';
import { validateMeta } from './validate';

const linksOf = (meta: Parameters<typeof renderMeta>[0]) =>
  renderMeta(meta).filter((tag) => tag.tag === 'link' && tag.attrs['rel'] !== 'canonical');

describe('unit · RouteMeta.links', () => {
  test('each link renders as a link tag, in declaration order, with only the fields given', () => {
    const links = linksOf({
      title: 'Home',
      links: [
        {
          rel: 'preload',
          href: '/assets/fonts/inter.3f2a1b9c.woff2',
          as: 'font',
          type: 'font/woff2',
          crossorigin: 'anonymous',
        },
        { rel: 'preconnect', href: 'https://cdn.example.test' },
        { rel: 'alternate', href: '/feed.xml', type: 'application/rss+xml', media: 'all' },
      ],
    });
    expect(links.map((tag) => tag.attrs)).toEqual([
      {
        rel: 'preload',
        href: '/assets/fonts/inter.3f2a1b9c.woff2',
        as: 'font',
        type: 'font/woff2',
        crossorigin: 'anonymous',
      },
      { rel: 'preconnect', href: 'https://cdn.example.test' },
      { rel: 'alternate', href: '/feed.xml', type: 'application/rss+xml', media: 'all' },
    ]);
  });

  test('an href that is not a URL a browser fetches is refused — X_SEO_LINK_INVALID', () => {
    for (const href of [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'java\tscript:x',
      'data:text/html,<p>',
      'vbscript:x',
    ]) {
      expect(() => linksOf({ title: 'x', links: [{ rel: 'prefetch', href }] })).toThrow(
        expect.objectContaining({ code: 'X_SEO_LINK_INVALID' }),
      );
    }
  });

  test('a preload with no `as` is refused: the browser ignores it and fetches nothing early', () => {
    expect(() => linksOf({ title: 'x', links: [{ rel: 'preload', href: '/a.woff2' }] })).toThrow(
      expect.objectContaining({ code: 'X_SEO_LINK_INVALID' }),
    );
  });

  test('a font preload without crossorigin is refused: the font would be fetched twice', () => {
    expect(() =>
      linksOf({ title: 'x', links: [{ rel: 'preload', href: '/a.woff2', as: 'font' }] }),
    ).toThrow(expect.objectContaining({ code: 'X_SEO_LINK_INVALID' }));
  });

  test('the build gate reports a bad link at the route file, before any request', () => {
    const report = validateMeta(
      [
        {
          path: '/',
          file: 'apps/web/site/index.tsx',
          surface: 'site',
          render: 'static',
          meta: {
            title: 'Home',
            description: 'x',
            links: [{ rel: 'preload', href: 'javascript:x', as: 'font' }],
          },
        },
      ],
      { checkDuplicates: false },
    );
    expect(report.issues.map((issue) => [issue.code, issue.file])).toEqual([
      ['X_SEO_LINK_INVALID', 'apps/web/site/index.tsx'],
    ]);
  });
});
