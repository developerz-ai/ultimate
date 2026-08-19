// A route is more than its URL and its render mode: the surface decides what the URL SERVES, and
// `offline`/`hydrate`/`budget`/`revalidateTags` decide what a visitor gets. None was classified,
// so flipping a page to `api` passed the contract gate.

import { describe, expect, test } from 'bun:test';
import type { ManifestSources } from './build';
import { diffManifest } from './diff';
import { fixtureManifest } from './diff-fixtures';

type Route = NonNullable<ManifestSources['routes']>[number];

const route = (overrides: Partial<Route> = {}): readonly Route[] => [
  {
    url: '/posts',
    render: 'isr',
    offline: 'precache',
    hydrate: 'idle',
    revalidateTags: ['post'],
    budget: { js: '40kb', lcp: 2000 },
    surface: 'site',
    ...overrides,
  },
];

const diff = (routes: readonly Route[]) =>
  diffManifest(fixtureManifest(), fixtureManifest({ routes }));

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
