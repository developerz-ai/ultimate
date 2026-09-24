// An async Page with no `load` renders, so no suite fails on it — the gate is the only thing that
// can say its data read skipped `load`'s cache and meta.

import { describe, expect, test } from 'bun:test';
import { defineRoute } from '@ultimat3/render';
import { asyncPageFindings } from './async-pages';

const config = defineRoute({
  render: 'ssr',
  hydrate: 'never',
  offline: 'network-only',
  meta: () => ({ title: 'Feed', description: 'x'.repeat(60) }),
});

describe('unit · an async Page with no load is X_ROUTE_ASYNC_PAGE', () => {
  test('async function and async arrow are both reported, with the edit naming the file', () => {
    const findings = asyncPageFindings([
      { file: 'apps/web/app/feed/page.tsx', config, component: async () => null },
      {
        file: 'apps/web/app/inbox/page.tsx',
        config,
        component: async function Page() {
          return null;
        },
      },
    ]);
    expect(findings.map((finding) => finding.at)).toEqual([
      'apps/web/app/feed/page.tsx',
      'apps/web/app/inbox/page.tsx',
    ]);
    expect(findings[0]?.code).toBe('X_ROUTE_ASYNC_PAGE');
    expect(findings[0]?.fix).toStartWith('in apps/web/app/feed/page.tsx: move each await in Page');
  });

  test('a sync Page, a route with load, and a route with no component are not', () => {
    // Widened to the registry's `RouteData`: the table holds every route's config under one type.
    const loaded = defineRoute({
      ...config,
      load: async (): Promise<Readonly<Record<string, unknown>>> => ({ rows: [] }),
    });
    expect(
      asyncPageFindings([
        { file: 'apps/web/app/a/page.tsx', config, component: () => null },
        { file: 'apps/web/app/b/page.tsx', config: loaded, component: async () => null },
        { file: 'apps/web/api/c/route.ts', config },
      ]),
    ).toEqual([]);
  });
});
