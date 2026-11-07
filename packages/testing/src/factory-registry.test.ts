// Registry-derived factories: a value comes from the column's DECLARATION, never its name (the name
// guess gave `postId` a fresh uuid and an enum `status-0`), plus the per-table seeding that keeps
// two entities from emitting the same ids.

import { describe, expect, test } from 'bun:test';
import {
  boolean,
  entity,
  enumerated,
  integer,
  invariant,
  json,
  money,
  t,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { defaultFor, factoriesFor } from './factory-registry';
import { testName } from './test-types';

const registry = {
  orgs: entity('fr_orgs', { columns: { id: uuid().primaryKey(), name: text() } }),
  posts: entity('fr_posts', {
    columns: {
      id: uuid().primaryKey(),
      title: text({ max: 40 }),
      status: enumerated(['draft', 'live'] as const).default('live'),
      kind: enumerated(['note', 'essay'] as const),
      publishedAt: timestamp().nullable(),
      price: money(),
      views: integer(),
      isDraft: boolean(),
      // Named like a timestamp and declared as text: the declaration decides.
      sentAt: text(),
    },
  }),
};

const ids = { uuid: () => '00000000-0000-4000-8000-000000000000', number: () => 42 };
const column = (property: keyof typeof registry.posts.$columns) => ({
  table: 'fr_posts',
  property,
  column: registry.posts.$columns[property],
  position: 0,
});

describe(testName('unit', 'defaultFor'), () => {
  test('reads the declaration: default, enum, money, kind — not the name', () => {
    expect(defaultFor(column('id'), 1, ids)).toBe('00000000-0000-4000-8000-000000000000');
    expect(defaultFor(column('status'), 1, ids)).toBe('live');
    expect(defaultFor(column('kind'), 2, ids)).toBe('essay');
    expect(defaultFor(column('price'), 1, ids)).toEqual({ minor: 100, currency: 'USD' });
    expect(defaultFor(column('views'), 3, ids)).toBe(3);
    expect(defaultFor(column('isDraft'), 1, ids)).toBe(false);
    expect(defaultFor(column('publishedAt'), 1, ids)).toBeInstanceOf(Date);
    expect(defaultFor(column('sentAt'), 3, ids)).toBe('sent-at-3');
    expect(defaultFor(column('title'), 3, ids)).toBe('title-3');
  });

  test('a nullable deletedAt builds null — a live row; a notNull one still gets a value', () => {
    const soft = entity('fr_soft', {
      columns: { id: uuid().primaryKey(), deletedAt: timestamp().nullable() },
    });
    const hard = entity('fr_hard', {
      columns: { id: uuid().primaryKey(), deletedAt: timestamp() },
    });
    const at = (column: unknown) => ({ table: 't', property: 'deletedAt', column, position: 1 });
    expect(defaultFor(at(soft.$columns.deletedAt), 1, ids)).toBeNull();
    expect(defaultFor(at(hard.$columns.deletedAt), 1, ids)).toBeInstanceOf(Date);
    // Only the soft-delete property: another nullable instant still gets one.
    expect(defaultFor(column('publishedAt'), 1, ids)).toBeInstanceOf(Date);
  });

  test('a value that is not an entity column refuses, naming the factory to write', () => {
    expect(() =>
      defaultFor({ table: 't', property: 'orgId', column: 0, position: 0 }, 1, ids),
    ).toThrow(expect.objectContaining({ code: 'X_SEED_GRAPH_UNSATISFIED' }));
  });

  test('a json(schema) column is built from its schema', () => {
    const shaped = entity('fr_usage', {
      columns: { id: uuid().primaryKey(), usage: json(t.object({ ms: t.number })) },
    });
    const target = { table: 'fr_usage', property: 'usage', column: shaped.$columns.usage };
    expect(defaultFor({ ...target, position: 1 }, 1, ids)).toEqual({ ms: expect.any(Number) });
  });

  test('a column that refuses every generated value refuses', () => {
    // A pattern the schema's own sampler cannot invert, so neither its draw nor {} / [] is stored.
    const shaped = entity('fr_shaped', {
      columns: {
        id: uuid().primaryKey(),
        usage: json(t.object({ ref: t.string.pattern(/^\d{3}$/) })),
      },
    });
    const target = { table: 'fr_shaped', property: 'usage', column: shaped.$columns.usage };
    expect(() => defaultFor({ ...target, position: 1 }, 1, ids)).toThrow(
      expect.objectContaining({ code: 'X_SEED_GRAPH_UNSATISFIED' }),
    );
  });
});

describe(testName('unit', 'factoriesFor'), () => {
  test('builds one factory per entity, keyed by the registry name', () => {
    const factories = factoriesFor(registry);
    expect(Object.keys(factories).sort()).toEqual(['orgs', 'posts']);
    expect(factories.posts.table).toBe('fr_posts');
  });

  test('fills every declared column and nothing else, each one storable', () => {
    expect(Object.keys(factoriesFor(registry).orgs.build()).sort()).toEqual(['id', 'name']);
    const post = factoriesFor(registry).posts.build();
    expect(() => registry.posts.$parse(post)).not.toThrow();
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

  test('a matches() pattern no fixed text shape meets is built from the pattern', () => {
    const orders = entity('fr_orders', {
      columns: { id: uuid().primaryKey(), ref: text({ max: 8 }) },
      invariants: (c) => [invariant('fr_order_ref_shape', c.ref.matches(/^ORD-\d{4}$/))],
    });
    const row = factoriesFor({ orders }).orders.build();
    expect(row['ref']).toMatch(/^ORD-\d{4}$/);
    // `build()` answers the registry's loose row; the rule reads the entity's own row type.
    expect(
      orders.$invariants.every((rule) => rule.holds(row as Parameters<typeof rule.holds>[0])),
    ).toBe(true);
  });

  test('a registry factory declares no traits', () => {
    expect(factoriesFor(registry).orgs.traits).toEqual([]);
  });
});
