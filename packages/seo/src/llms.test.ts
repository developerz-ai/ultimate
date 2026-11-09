// `/llms.txt`: the indexable `site/` pages by title and description, empty outside production and
// when the app opts out, and the description rule the `seo` step enforces.

import { describe, expect, test } from 'bun:test';
import { buildLlmsTxt, llmsDescriptionIssues } from './llms';
import type { RouteRecord } from './routes';

const route = (path: string, meta: RouteRecord['meta'], extra: Partial<RouteRecord> = {}) =>
  ({
    path,
    file: `apps/web/site${path}/page.tsx`,
    surface: 'site',
    render: 'static',
    meta,
    ...extra,
  }) as RouteRecord;

const ROUTES: readonly RouteRecord[] = [
  route('/pricing', { title: 'Pricing', description: 'Plans, per seat.' }),
  route('/', { title: 'Postly', description: 'Posts for teams.\nNo ads.' }),
  route('/drafts', { title: 'Drafts', robots: { index: false } }),
  route('/blog/:slug', { title: 'Post' }),
  route('/app-only', { title: 'Inside' }, { surface: 'app' }),
  route('/about', { title: 'About [us]' }),
];
const SITE = { baseUrl: 'https://postly.example/', environment: 'production' } as const;

describe('buildLlmsTxt', () => {
  test('the home page names the site; every indexable static site/ page is one line', () => {
    expect(buildLlmsTxt(ROUTES, SITE)).toBe(
      [
        '# Postly',
        '',
        '> Posts for teams. No ads.',
        '',
        '- [Postly](https://postly.example): Posts for teams. No ads.',
        '- [About \\[us\\]](https://postly.example/about)',
        '- [Pricing](https://postly.example/pricing): Plans, per seat.',
        '',
      ].join('\n'),
    );
  });

  test('anything but production, and seo.llms: false, answer an empty document', () => {
    expect(buildLlmsTxt(ROUTES, { ...SITE, environment: 'staging' })).toBe('');
    expect(buildLlmsTxt(ROUTES, { ...SITE, enabled: false })).toBe('');
  });
});

describe('llmsDescriptionIssues', () => {
  test('a listed page with no description is the one finding; noindex and app/ pages are not listed', () => {
    const issues = llmsDescriptionIssues(ROUTES);
    expect(issues.map((issue) => [issue.code, issue.route])).toEqual([
      ['X_SEO_LLMS_DESCRIPTION_MISSING', '/about'],
    ]);
    expect(issues[0]?.fix).toContain('apps/web/site/about/page.tsx');
  });
});

describe('a link destination stays one link', () => {
  // Markdown ends a destination at a space or an unbalanced `)`: `/a b(c)` linked to `/a`, and the
  // rest of the URL became prose. Percent-encoding those three never double-encodes a path.
  test('a space or a parenthesis in a path is percent-encoded', () => {
    const routes = [route('/', { title: 'Home' }), route('/a b(c)', { title: 'Odd' })];
    expect(buildLlmsTxt(routes, SITE)).toContain('- [Odd](https://postly.example/a%20b%28c%29)');
  });
});
