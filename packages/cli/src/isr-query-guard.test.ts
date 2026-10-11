// The `query` a page is handed, under `revalidate.query`. An `isr` page is stored under its
// DECLARED parameters only, so a read of any other one is a document that varies on something its
// key does not carry. Outside production that read is said once, by route and by name.

import { afterEach, describe, expect, test } from 'bun:test';
import type { LogSink } from '@ultimat3/core';
import { setLogSink } from '@ultimat3/core';
import type { RouteEntry } from '@ultimat3/render';
import { clearRoutes, defineRoute, registerRoute } from '@ultimat3/render';
import { routeQuery } from './isr-query-guard';

const entryOf = (file: string, render: 'isr' | 'ssr', query?: readonly string[]): RouteEntry =>
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
  }) as RouteEntry;

afterEach(() => {
  clearRoutes();
});

function warned(run: () => void): readonly string[] {
  const lines: string[] = [];
  const collect: LogSink = (line) => {
    lines.push(line);
  };
  const previous = setLogSink(collect);
  try {
    run();
  } finally {
    setLogSink(previous);
  }
  return lines.filter((line) => line.includes('isr.query.unkeyed-read'));
}

const at = new URL('https://app.test/pricing?currency=EUR');
const DEV = { ULTIMATE_ENV: 'development' };

describe('unit · a page reading a query parameter its isr key does not carry', () => {
  test('is told once per route and parameter, and still gets the value the URL holds', () => {
    const entry = entryOf('apps/web/site/pricing/page.tsx', 'isr', ['currency']);
    const lines = warned(() => {
      const query = routeQuery(entry, at, DEV);
      expect(query['currency']).toBe('EUR');
      expect(query['plan']).toBeUndefined();
      expect(routeQuery(entry, at, DEV)['plan']).toBeUndefined();
      expect(routeQuery(entry, at, DEV)['tab']).toBeUndefined();
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('apps/web/site/pricing/page.tsx');
    expect(lines[0]).toContain("query: ['currency', 'plan']");
  });

  test('what a renderer asks of any object is not a parameter read', () => {
    const entry = entryOf('apps/web/site/guard-probes/page.tsx', 'isr', []);
    const lines = warned(() => {
      // The URL a page is rendered at is already narrowed to what the route declared.
      const query = routeQuery(entry, new URL('https://app.test/pricing'), DEV);
      JSON.stringify(query);
      String(Reflect.get(query, 'toString'));
      Reflect.get(query, 'then');
      Reflect.get(query, Symbol.iterator);
      expect({ ...query }).toEqual({});
    });
    expect(lines).toEqual([]);
  });

  test('production gets the plain object: no proxy, no line', () => {
    const entry = entryOf('apps/web/site/guard-prod/page.tsx', 'isr', []);
    const lines = warned(() => {
      const query = routeQuery(entry, at, { ULTIMATE_ENV: 'production' });
      expect(query['plan']).toBeUndefined();
      expect(Object.getPrototypeOf(query)).toBe(Object.prototype);
    });
    expect(lines).toEqual([]);
  });

  test('a route that declared no query, or is not isr, is never wrapped', () => {
    const lines = warned(() => {
      routeQuery(entryOf('apps/web/site/guard-none/page.tsx', 'isr'), at, DEV)['plan'];
      routeQuery(entryOf('apps/web/site/guard-ssr/page.tsx', 'ssr'), at, DEV)['plan'];
    });
    expect(lines).toEqual([]);
  });
});
