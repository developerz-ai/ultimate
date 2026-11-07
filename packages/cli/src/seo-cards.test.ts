// The `og.capture` convention as `x verify`'s `seo` step enforces it: a declared card path that no
// `site/` route answers is `X_SEO_CARD_ROUTE_UNKNOWN`, naming the file that declared it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import type { RouteRecord } from '@ultimat3/seo';
import { cardRouteFindings } from './seo-cards';

type Ctx = { url: string; params: Record<string, string> };

const page = (file: string): void => {
  registerRoute<Ctx>({
    file,
    config: defineRoute<Ctx>({
      render: 'static',
      offline: 'network-only',
      hydrate: 'never',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Card', robots: { index: false } }),
    }),
  });
};

const declaring = (capture: string): RouteRecord => ({
  path: '/',
  file: 'apps/web/site/page.tsx',
  surface: 'site',
  render: 'static',
  meta: { title: 'Home', description: 'Home page', og: { capture } },
});

beforeEach(() => clearRoutes());
afterEach(() => clearRoutes());

describe('unit · cardRouteFindings', () => {
  test('a capture path a site/ page answers — static or dynamic — is clean', () => {
    page('apps/web/site/og/home/page.tsx');
    page('apps/web/site/og/post/[slug]/page.tsx');
    expect(cardRouteFindings([declaring('/og/home'), declaring('/og/post/hello')])).toEqual([]);
  });

  test('a capture path no route answers is X_SEO_CARD_ROUTE_UNKNOWN at the declaring file', () => {
    page('apps/web/site/og/home/page.tsx');
    const [finding, ...rest] = cardRouteFindings([declaring('/og/homepage')]);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_SEO_CARD_ROUTE_UNKNOWN');
    expect(finding?.at).toBe('apps/web/site/page.tsx');
    expect(finding?.cause).toContain('/og/homepage');
  });
});
