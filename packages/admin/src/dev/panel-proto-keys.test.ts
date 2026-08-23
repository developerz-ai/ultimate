// Every /_x panel that COUNTS into a plain object, driven with the four names
// `Object.prototype` already answers for.
//
// `count[key] = (count[key] ?? 0) + 1` reads a prototype value for `__proto__`, `constructor`,
// `toString` and `hasOwnProperty` — so `?? 0` never fires — and then WRITES it back: for
// `__proto__` that runs the setter on `Object.prototype`, which re-prototypes the record instead
// of adding a key, and the row vanishes from the panel entirely. Fourth instance of the class in
// the framework, after `@ultimat3/i18n`'s catalog lookup, `@ultimat3/schema`'s `coerce` and
// `@ultimat3/mcp`'s `validate-args`.

import { describe, expect, test } from 'bun:test';
import { staticDevSources } from './data';
import type { CacheEdgeFact, PolicyFact, RouteFact } from './facts';
import { cachePanel } from './panel-cache';
import { policyPanel } from './panel-policy';
import { routesPanel } from './panel-routes';

/** The four names a plain `{}` answers for without anybody having written them. */
const INHERITED = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const;

const route = (path: string, render: string): RouteFact =>
  ({
    path,
    render,
    hydrate: 'never',
    offline: 'none',
    budget: { js: '10kb' },
    revalidate: null,
    policy: null,
  }) as unknown as RouteFact;

describe('a panel counting into a record is not confused by an inherited name', () => {
  test('the cache panel counts a dependent kind that collides with Object.prototype', async () => {
    const graph: readonly CacheEdgeFact[] = INHERITED.map((kind) => ({
      tag: `tag:${kind}`,
      dependents: [{ kind, id: 'x' }],
    })) as unknown as readonly CacheEdgeFact[];
    const data = await cachePanel.data(
      staticDevSources({ cacheGraph: () => Promise.resolve(graph) }),
      new URLSearchParams(),
    );

    for (const kind of INHERITED) {
      expect(Object.hasOwn(data.byKind, kind)).toBe(true);
      expect(data.byKind[kind]).toBe(1);
    }
  });

  test('the routes panel counts a render mode that collides with Object.prototype', async () => {
    const routes = INHERITED.map((render, index) => route(`/p${String(index)}`, render));
    const data = await routesPanel.data(
      staticDevSources({ routes: () => Promise.resolve(routes) }),
      new URLSearchParams(),
    );

    for (const render of INHERITED) {
      expect(Object.hasOwn(data.byRenderMode, render)).toBe(true);
      expect(data.byRenderMode[render]).toBe(1);
    }
  });

  test('the policy matrix keeps a cell for an actor id that collides with Object.prototype', async () => {
    // `__proto__` is the sharp one: the assignment ran the setter, so `Object.values(byActor)`
    // missed the cell and the panel reported the permission as held by nobody — unreachable.
    const facts: readonly PolicyFact[] = INHERITED.map((actorId) => ({
      actorId,
      permission: 'admin:read',
      allowed: true,
      trace: [],
    }));
    const data = await policyPanel.data(
      staticDevSources({ policyMatrix: () => Promise.resolve(facts) }),
      new URLSearchParams(),
    );

    const row = data.matrix[0];
    expect(row?.permission).toBe('admin:read');
    for (const actorId of INHERITED) {
      expect(Object.hasOwn(row?.byActor ?? {}, actorId)).toBe(true);
      expect(row?.byActor[actorId]).toBe(true);
    }
    expect(data.unreachable).toEqual([]);
  });
});
