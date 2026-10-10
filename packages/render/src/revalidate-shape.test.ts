// `revalidate`'s optional keys are read by the ISR controller on every request, so a value it
// cannot act on is refused when the route is defined — never read as its permissive default.

import { describe, expect, test } from 'bun:test';
import { tag } from '@ultimat3/cache';
import { clearRoutes, describePages, registerRoute } from './registry';
import type { RevalidateConfig, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const define = (revalidate: RevalidateConfig) => () =>
  defineRoute({ render: 'isr', revalidate, offline: 'precache', hydrate: 'never', meta });
const refused = { code: 'X_ROUTE_MODE_INVALID' };
/** A value the type refuses, as a JS caller or a cast would hand it over. */
const untyped = (value: unknown): RevalidateConfig => value as RevalidateConfig;

describe('unit · revalidate options are screened at defineRoute', () => {
  test('a full declaration is accepted and projected onto the descriptor', () => {
    clearRoutes();
    registerRoute({
      file: 'apps/web/site/blog/page.tsx',
      config: define({
        tags: [tag('post')],
        ttl: '5m',
        onInvalidate: 'purge',
        maxStale: '1h',
        query: ['pagina', 'categoria', 'pagina'],
      })(),
    });
    const [route] = describePages();
    clearRoutes();
    expect(route?.revalidateOnInvalidate).toBe('purge');
    expect(route?.revalidateMaxStale).toBe('1h');
    expect(route?.revalidateQuery).toEqual(['categoria', 'pagina']);
  });

  test('a route that declares none of them gets today’s behaviour', () => {
    clearRoutes();
    registerRoute({ file: 'apps/web/site/blog/page.tsx', config: define({ ttl: '5m' })() });
    const [route] = describePages();
    clearRoutes();
    expect(route?.revalidateOnInvalidate).toBe('stale');
    expect(route?.revalidateMaxStale).toBeNull();
    // Undeclared is `null`, not `[]`: the page still keys on the whole query string.
    expect(route?.revalidateQuery).toBeNull();
  });

  test('an unknown onInvalidate is refused', () => {
    expect(define(untyped({ tags: [tag('post')], onInvalidate: 'delete' }))).toThrow(
      expect.objectContaining(refused),
    );
  });

  test("'purge' with no tags has nothing to purge by", () => {
    expect(define({ ttl: '5m', onInvalidate: 'purge' })).toThrow(expect.objectContaining(refused));
  });

  test('a maxStale that is no duration, or that has no ttl to count from, is refused', () => {
    expect(define({ ttl: '5m', maxStale: '1 hour' })).toThrow(expect.objectContaining(refused));
    expect(define({ ttl: '5m', maxStale: 0 })).toThrow(expect.objectContaining(refused));
    expect(define({ tags: [tag('post')], maxStale: '1h' })).toThrow(
      expect.objectContaining(refused),
    );
  });

  test('a query entry that is no parameter name, or is the framework’s own, is refused', () => {
    expect(define({ ttl: '5m', query: [''] })).toThrow(expect.objectContaining(refused));
    expect(define(untyped({ ttl: '5m', query: 'pagina' }))).toThrow(
      expect.objectContaining(refused),
    );
    expect(define({ ttl: '5m', query: ['__x_locale'] })).toThrow(expect.objectContaining(refused));
  });
});
