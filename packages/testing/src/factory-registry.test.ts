// Registry-derived factories: the column NAME is the only input, so these pin the mapping and the
// per-table seeding that keeps two entities from emitting the same ids.

import { describe, expect, test } from 'bun:test';
import type { EntityLike } from './factories';
import { defaultFor, factoriesFor } from './factory-registry';
import { testName } from './test-types';

const registry = {
  orgs: { kind: 'entity', table: 'orgs', columns: { id: 0, name: 0 } },
  posts: {
    kind: 'entity',
    table: 'posts',
    columns: {
      id: 0,
      orgId: 0,
      title: 0,
      publishedAt: 0,
      priceMinor: 0,
      priceCurrency: 0,
      isDraft: 0,
    },
  },
} satisfies Readonly<Record<string, EntityLike>>;

const ids = { uuid: () => 'uuid', number: () => 42 };

describe(testName('unit', 'defaultFor'), () => {
  test('maps a column name to a value its column type accepts', () => {
    expect(defaultFor('id', 1, ids)).toBe('uuid');
    expect(defaultFor('orgId', 1, ids)).toBe('uuid');
    expect(defaultFor('publishedAt', 1, ids)).toEqual(new Date(0));
    expect(defaultFor('priceMinor', 1, ids)).toBe(42);
    expect(defaultFor('priceCurrency', 1, ids)).toBe('USD');
    expect(defaultFor('isDraft', 1, ids)).toBe(false);
    expect(defaultFor('hasSeats', 1, ids)).toBe(false);
    expect(defaultFor('title', 3, ids)).toBe('title-3');
  });
});

describe(testName('unit', 'factoriesFor'), () => {
  test('builds one factory per entity, keyed by the registry name', () => {
    const factories = factoriesFor(registry);
    expect(Object.keys(factories).sort()).toEqual(['orgs', 'posts']);
    expect(factories.posts.table).toBe('posts');
  });

  test('fills every declared column and nothing else', () => {
    expect(Object.keys(factoriesFor(registry).orgs.build()).sort()).toEqual(['id', 'name']);
  });

  test('two entities in one registry do not share an id stream', () => {
    const factories = factoriesFor(registry);
    expect(factories.orgs.build()['id']).not.toBe(factories.posts.build()['id']);
  });

  test('an explicit seed is honoured, and then both tables do replay it', () => {
    // Stated rather than hidden: passing one seed is asking for one stream, which is only ever
    // right when the caller wants a run to match an older recording.
    const factories = factoriesFor(registry, 5);
    expect(factories.orgs.build()['id']).toBe(factories.posts.build()['id']);
  });

  test('a registry factory declares no traits', () => {
    expect(factoriesFor(registry).orgs.traits).toEqual([]);
  });
});
