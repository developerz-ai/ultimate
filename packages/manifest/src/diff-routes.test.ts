// A route is more than its URL and its render mode: the surface decides what the URL SERVES, and
// `offline`/`hydrate`/`budget`/`revalidateTags` decide what a visitor gets. None was classified,
// so flipping a page to `api` passed the contract gate.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixture';

type Route = NonNullable<ManifestSources['routes']>[number];

const route = (overrides: Partial<Route> = {}): readonly Route[] => [
  {
    url: '/posts',
    render: 'isr',
    offline: 'precache',
    hydrate: 'idle',
    revalidateTags: ['post'],
    budget: { js: '40kb' },
    surface: 'site',
    ...overrides,
  },
];

const diff = (routes: readonly Route[]) =>
  diffManifest(fixtureManifest(), fixtureManifest({ routes }));

/** The route changes alone: a manifest's own `buildId` moves with any of them. */
const routePaths = (changes: readonly { readonly path: string }[]): readonly string[] =>
  changes.map((c) => c.path).filter((path) => path.startsWith('routes.'));

describe('route facts', () => {
  test('a changed surface is breaking — the URL serves a different kind of thing', () => {
    const changed = diff(route({ surface: 'api' }));
    expect(changed.hasBreaking).toBe(true);
    expect(changed.breaking.map((c) => c.path)).toContain('routes./posts.surface');
    expect(changed.breaking.find((c) => c.path === 'routes./posts.surface')?.detail).toContain(
      'site -> api',
    );
  });

  test('offline, hydrate, budget and revalidate tags are internal but reported', () => {
    for (const [path, overrides] of [
      ['routes./posts.offline', { offline: 'network-only' as const }],
      ['routes./posts.hydrate', { hydrate: 'never' as const }],
      ['routes./posts.budget', { budget: { js: '80kb' } }],
      ['routes./posts.revalidateTags', { revalidateTags: [] }],
    ] as const) {
      const changed = diff(route(overrides));
      expect(changed.hasBreaking).toBe(false);
      expect(changed.internal.map((c) => c.path)).toContain(path);
    }
  });

  // `render` is the one route field the loop above never moved, and it is the field that decides
  // whether a URL is prerendered or served per request — an unclassified change there is a page
  // silently switching cost model between two committed manifests.
  test('a changed render mode is internal, and the detail names both modes', () => {
    const changed = diff(route({ render: 'ssr' }));
    expect(changed.hasBreaking).toBe(false);
    const entry = changed.internal.find((c) => c.path === 'routes./posts.render');
    expect(entry?.detail).toBe('render isr -> ssr');
  });

  // A route flipping `'purge'` back to `'stale'` puts a withdrawn page back on "served once more",
  // and nothing else in the manifest moves when it does.
  test('onInvalidate, maxStale and query are internal but reported, once both manifests carry them', () => {
    const purge = { onInvalidate: 'purge' as const, maxStale: '1h', query: ['page'] };
    const from = fixtureManifest({ routes: route(purge) });
    for (const [path, overrides] of [
      ['routes./posts.onInvalidate', { ...purge, onInvalidate: 'stale' as const }],
      ['routes./posts.maxStale', { ...purge, maxStale: '2h' }],
      ['routes./posts.query', { ...purge, query: ['page', 'q'] }],
    ] as const) {
      const changed = diffManifest(from, fixtureManifest({ routes: route(overrides) }));
      expect(changed.hasBreaking).toBe(false);
      expect(routePaths(changed.internal)).toEqual([path]);
    }
    const flipped = diffManifest(
      from,
      fixtureManifest({ routes: route({ ...purge, onInvalidate: 'stale' }) }),
    );
    expect(flipped.internal.find((c) => c.path === 'routes./posts.onInvalidate')?.detail).toBe(
      'onInvalidate purge -> stale',
    );
  });

  test('a query declaration that is DROPPED is a change: the page keys on the whole query again', () => {
    const from = fixtureManifest({ routes: route({ onInvalidate: 'stale', query: [] }) });
    const to = fixtureManifest({ routes: route({ onInvalidate: 'stale' }) });
    expect(routePaths(diffManifest(from, to).internal)).toEqual(['routes./posts.query']);
  });

  test('a manifest written before these keys existed reports nothing for them', () => {
    const to = fixtureManifest({ routes: route({ onInvalidate: 'purge', query: [] }) });
    expect(
      diffManifest(fixtureManifest({ routes: route() }), to).changes.filter((c) =>
        c.path.startsWith('routes./posts.'),
      ),
    ).toEqual([]);
  });

  test('a route that only the after side has is additive, not a removal', () => {
    const added = diffManifest(
      fixtureManifest(),
      fixtureManifest({ routes: [...route(), ...route({ url: '/about', render: 'static' })] }),
    );
    expect(added.hasBreaking).toBe(false);
    expect(added.additive.map((c) => c.path)).toContain('routes./about');
    expect(added.additive.find((c) => c.path === 'routes./about')?.detail).toBe('route added');
    // And the route both sides carry is not re-reported as arriving.
    expect(added.changes.filter((c) => c.path === 'routes./posts')).toEqual([]);
  });

  test('an unchanged route reports nothing of its own', () => {
    expect(diff(route()).changes.filter((c) => c.path.startsWith('routes.'))).toEqual([]);
  });

  // `before` is a file off disk: a manifest written before `surface` existed carries none, and
  // reading absence as a value would report every route as newly re-surfaced on the first diff.
  test('a manifest that omits an optional route field reports no change for it', () => {
    const before = fixtureManifest();
    const trimmed = JSON.parse(JSON.stringify(before)) as typeof before;
    for (const fact of trimmed.routes) {
      for (const field of ['surface', 'offline', 'hydrate', 'budget', 'revalidateTags']) {
        delete (fact as unknown as Record<string, unknown>)[field];
      }
    }
    expect(
      diffManifest(trimmed, before).changes.filter((c) => c.path.startsWith('routes./posts.')),
    ).toEqual([]);
  });
});
