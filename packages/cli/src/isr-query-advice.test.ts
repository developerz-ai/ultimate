// `x verify`'s advice for an `isr` route that never declared its query: the one place a route that
// keys on the whole query string is named before a visitor finds it.

import { afterEach, describe, expect, test } from 'bun:test';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { isrQueryAdvice } from './isr-query-advice';

const page = (file: string, render: 'isr' | 'ssr', query?: readonly string[]): void => {
  registerRoute({
    file,
    component: () => 'page',
    config: defineRoute({
      render,
      ...(render === 'isr'
        ? { revalidate: query === undefined ? { ttl: '5m' } : { ttl: '5m', query } }
        : {}),
      hydrate: 'never',
      offline: 'network-only',
      budget: { js: '0kb' },
      meta: () => ({ title: 'Page', description: 'a page' }),
    }),
  });
};

afterEach(() => {
  clearRoutes();
});

describe('unit · isr query advice', () => {
  test('names each isr route with no revalidate.query, and no other route', () => {
    page('apps/web/site/blog/page.tsx', 'isr');
    page('apps/web/site/pricing/page.tsx', 'isr', []);
    page('apps/web/site/search/page.tsx', 'isr', ['q']);
    page('apps/web/site/about/page.tsx', 'ssr');
    const advice = isrQueryAdvice();
    expect(advice).toHaveLength(1);
    expect(advice[0]).toStartWith('apps/web/site/blog/page.tsx: ');
    expect(advice[0]).toContain('revalidate: { query: [] }');
  });
});
