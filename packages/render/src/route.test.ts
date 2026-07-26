import { describe, expect, test } from 'bun:test';
import { RouteMetaMissingError, RouteOfflineMissingError } from './errors';
import type { RouteDefinition, RouteMetaFn } from './route';
import { defineRoute, isRouteConfig } from './route';

/** UltimateError carries a `fix`; read it structurally so the test needs no core import. */
export function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

const meta = (() => ({
  title: 'Title',
  description: 'A description that is comfortably inside the fifty-to-one-sixty range.',
})) as unknown as RouteMetaFn;

describe('defineRoute', () => {
  test('offline is required by the type — axiom 3 lives in the type system', () => {
    // @ts-expect-error `offline` is not optional: a route cannot ship without a strategy.
    const definition: RouteDefinition = { render: 'static', hydrate: 'never', meta };
    expect(() => defineRoute(definition)).toThrow(RouteOfflineMissingError);
  });

  test('meta is required by the type on every route', () => {
    // @ts-expect-error `meta` is not optional: a route cannot ship without a <head>.
    const definition: RouteDefinition = { render: 'static', offline: 'precache', hydrate: 'never' };
    expect(() => defineRoute(definition)).toThrow(RouteMetaMissingError);
  });

  test('an unknown offline strategy is rejected with the allowed set', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'static',
        // @ts-expect-error not an offline strategy
        offline: 'sometimes',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('precache | runtime | network-only');
  });

  test('returns a frozen, branded config with optional keys omitted', () => {
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'never',
      meta,
    });
    expect(isRouteConfig(config)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect('revalidate' in config).toBe(false);
    expect('policy' in config).toBe(false);
  });
});
