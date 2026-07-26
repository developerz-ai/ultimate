import { describe, expect, test } from 'bun:test';
import { RouteModeInvalidError } from './errors';
import { assertModeInvariants } from './modes';
import { clearRoutes, registerRoute } from './registry';
import type { RouteConfig, RouteGuard, RouteMetaFn } from './route';
import { defineRoute } from './route';

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;
const guard: RouteGuard = { permission: 'dashboard:read' };

function fixOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'fix' in error ? String(error.fix) : '';
}

describe('per-mode registration invariants', () => {
  test('static cannot read per-request state (no policy)', () => {
    expect(() =>
      defineRoute({
        render: 'static',
        offline: 'precache',
        hydrate: 'never',
        meta,
        policy: guard,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('static cannot declare revalidate', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'static',
        revalidate: { ttl: '5m' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain("change render to 'isr'");
  });

  test('isr requires either revalidate.tags or a ttl', () => {
    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { tags: [] },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    ).toThrow(RouteModeInvalidError);

    expect(() =>
      defineRoute({
        render: 'isr',
        revalidate: { ttl: '5m' },
        offline: 'precache',
        hydrate: 'never',
        meta,
      }),
    ).not.toThrow();
  });

  test('ssr cannot be prerendered', () => {
    let fix = '';
    try {
      defineRoute({
        render: 'ssr',
        prerender: () => ['a'],
        offline: 'network-only',
        hydrate: 'never',
        meta,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('remove prerender');
  });

  test('spa requires a policy — it is for authed dashboards', () => {
    expect(() =>
      defineRoute({ render: 'spa', offline: 'precache', hydrate: 'idle', meta }),
    ).toThrow(RouteModeInvalidError);

    expect(() =>
      defineRoute({ render: 'spa', offline: 'precache', hydrate: 'idle', meta, policy: guard }),
    ).not.toThrow();
  });

  test('stream requires at least one suspense boundary', () => {
    const config: RouteConfig = defineRoute({
      render: 'stream',
      offline: 'runtime',
      hydrate: 'idle',
      meta,
    });

    let fix = '';
    try {
      assertModeInvariants(config, {
        file: 'apps/web/app/dashboard/page.tsx',
        path: '/dashboard',
        surface: 'app',
        suspenseBoundaries: 0,
      });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('<Suspense');

    expect(() =>
      assertModeInvariants(config, {
        file: 'apps/web/app/dashboard/page.tsx',
        path: '/dashboard',
        surface: 'app',
        suspenseBoundaries: 2,
      }),
    ).not.toThrow();
  });
});

describe('surface-level mode rules', () => {
  test('site/ rejects app-only modes and app/ rejects static', () => {
    clearRoutes();
    const streamConfig = defineRoute({
      render: 'stream',
      offline: 'runtime',
      hydrate: 'idle',
      meta,
    });
    expect(() =>
      registerRoute({
        file: 'apps/web/site/pricing/page.tsx',
        config: streamConfig,
        suspenseBoundaries: 1,
      }),
    ).toThrow(RouteModeInvalidError);
  });

  test('hydrating a site/ route without a js budget is a build error', () => {
    clearRoutes();
    const config = defineRoute({
      render: 'static',
      offline: 'precache',
      hydrate: 'visible',
      meta,
    });
    let fix = '';
    try {
      registerRoute({ file: 'apps/web/site/pricing/page.tsx', config });
    } catch (error) {
      fix = fixOf(error);
    }
    expect(fix).toContain('budget: { js:');
  });
});
