// The seed graph against real `entity()` declarations: determinism, same-tenant parents, a cycle
// broken at its nullable edge, and the two refusals — a non-nullable cycle and a rule no generated
// value keeps — each naming the factory that would answer it.

import { describe, expect, test } from 'bun:test';
import {
  type AnyColumn,
  entity,
  enumerated,
  iff,
  integer,
  invariant,
  money,
  SOFT_DELETE_COLUMN,
  text,
  timestamp,
  url,
  uuid,
} from '@ultimat3/entity';
import { defineFactory } from './factories';
import { seedGraph } from './seed-graph';
import { insertSeedGraph, type SeedRow, type SeedUpdate } from './seed-graph-plan';
import { SEED_SOFT_DELETE_PROPERTY } from './seed-graph-shape';
import { testName } from './test-types';

const orgs = entity('sg_orgs', {
  columns: { id: uuid().primaryKey(), slug: text({ max: 40 }).unique(), createdAt: timestamp() },
  invariants: (c) => [invariant('sg_org_slug_shape', c.slug.matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))],
});
const members = entity('sg_members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    email: text({ max: 254 }),
    role: enumerated(['owner', 'author'] as const).default('author'),
  },
  invariants: (c) => [invariant('sg_member_email', c.email.matches(/^[^@]+@[^@]+$/))],
});
const posts = entity('sg_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    authorId: uuid().references(() => members.id),
    status: enumerated(['draft', 'published'] as const),
    publishedAt: timestamp().nullable(),
    coverUrl: url().nullable(),
    price: money(),
    likeCount: integer().default(0),
  },
  invariants: (c) => [
    invariant('sg_post_published', iff(c.status.eq('published'), c.publishedAt.isNotNull())),
  ],
});
const schema = { orgs, members, posts };

describe(testName('unit', 'seedGraph'), () => {
  test('the same seed gives the same rows, byte for byte; another seed does not', () => {
    const first = seedGraph(schema, { seed: 7 });
    expect(JSON.stringify(seedGraph(schema, { seed: 7 }))).toBe(JSON.stringify(first));
    expect(seedGraph(schema, { seed: 8 }).inserts[0]?.row['id']).not.toBe(
      first.inserts[0]?.row['id'],
    );
  });

  test('parents insert first, one tenant root row per tenant, perTable rows per tenant', () => {
    const graph = seedGraph(schema, { tenants: 2, perTable: 3 });
    expect(graph.order).toEqual(['sg_orgs', 'sg_members', 'sg_posts']);
    const of = (name: string) => graph.inserts.filter((row) => row.entity === name);
    expect(of('sg_orgs').map((row) => row.row['id'])).toEqual([...graph.tenants]);
    expect(of('sg_members')).toHaveLength(6);
    expect(of('sg_posts')).toHaveLength(6);
  });

  test('every reference points at a parent of the same tenant', () => {
    const graph = seedGraph(schema, { tenants: 3, perTable: 2 });
    const tenantOf = new Map(graph.inserts.map((row) => [row.row['id'], row.tenant]));
    for (const post of graph.inserts.filter((row) => row.entity === 'sg_posts')) {
      expect(post.row['orgId']).toBe(post.tenant);
      expect(tenantOf.get(post.row['authorId'])).toBe(post.tenant);
    }
  });

  test('a value comes from the declaration: enum values, money parts, a url, a kept rule', () => {
    const graph = seedGraph(schema, { perTable: 2 });
    for (const { row, entity: name } of graph.inserts) {
      if (name === 'sg_members') expect(row['email']).toMatch(/^[^@]+@[^@]+$/);
      if (name !== 'sg_posts') continue;
      const statuses: readonly unknown[] = ['draft', 'published'];
      expect(statuses).toContain(row['status']);
      expect(row['status'] === 'published').toBe(row['publishedAt'] !== null);
      expect(row['price']).toEqual({ minor: expect.any(Number), currency: 'USD' });
      expect(String(row['coverUrl'])).toStartWith('https://');
      expect(row['likeCount']).toBe(0);
    }
  });

  test('every row records a canary its text columns carry', () => {
    const graph = seedGraph(schema);
    expect(graph.canaries).toHaveLength(graph.inserts.length);
    const slug = graph.inserts[0]?.row['slug'];
    expect(String(slug)).toContain(graph.canaries[0]?.marker ?? '-');
    expect(graph.canaries[0]?.columns).toContain('slug');
  });

  test('a soft-deleting table seeds live rows: its deletedAt is null, not a generated instant', () => {
    const notes = entity('sg_notes', {
      columns: {
        id: uuid().primaryKey(),
        editedAt: timestamp().nullable(),
        [SOFT_DELETE_COLUMN]: timestamp().nullable(),
      },
    });
    expect(SEED_SOFT_DELETE_PROPERTY).toBe(SOFT_DELETE_COLUMN);
    const rows = seedGraph({ notes }).inserts.map((insert) => insert.row);
    expect(rows.map((row) => row[SOFT_DELETE_COLUMN])).toEqual([null, null, null]);
    // Only the soft-delete column: any other nullable instant still gets a value.
    expect(rows.every((row) => row['editedAt'] instanceof Date)).toBe(true);
  });

  test('a unique column that runs out of values ends its table early, it does not refuse', () => {
    const slots = entity('sg_slots', {
      columns: { id: uuid().primaryKey(), slot: enumerated(['a', 'b'] as const).unique() },
    });
    expect(seedGraph({ slots }, { perTable: 5 }).inserts).toHaveLength(2);
  });
});

describe(testName('unit', 'seedGraph cycles'), () => {
  const teams = entity('sg_teams', {
    columns: {
      id: uuid().primaryKey(),
      captainId: uuid()
        .references((): AnyColumn => players.id)
        .nullable(),
    },
  });
  const players = entity('sg_players', {
    columns: { id: uuid().primaryKey(), teamId: uuid().references((): AnyColumn => teams.id) },
  });

  test('a cycle inserts its nullable side null, then updates it to a real row', async () => {
    const graph = seedGraph({ teams, players }, { perTable: 2 });
    expect(graph.order).toEqual(['sg_teams', 'sg_players']);
    expect(
      graph.inserts.filter((r) => r.entity === 'sg_teams').map((r) => r.row['captainId']),
    ).toEqual([null, null]);
    const playerIds = graph.inserts
      .filter((r) => r.entity === 'sg_players')
      .map((r) => r.row['id']);
    expect(graph.updates).toHaveLength(2);
    for (const update of graph.updates) expect(playerIds).toContain(update.patch['captainId']);

    const written: (SeedRow | SeedUpdate)[] = [];
    await insertSeedGraph(graph, {
      insert: async (row) => void written.push(row),
      update: async (update) => void written.push(update),
    });
    expect(written).toEqual([...graph.inserts, ...graph.updates]);
  });

  test('a cycle with no nullable key refuses, naming the factory to write', () => {
    const eggs = entity('sg_eggs', {
      columns: { id: uuid().primaryKey(), henId: uuid().references((): AnyColumn => hens.id) },
    });
    const hens = entity('sg_hens', {
      columns: { id: uuid().primaryKey(), eggId: uuid().references((): AnyColumn => eggs.id) },
    });
    expect(() => seedGraph({ eggs, hens })).toThrow(
      expect.objectContaining({
        code: 'X_SEED_GRAPH_UNSATISFIED',
        fix: expect.stringContaining('defineFactory('),
      }),
    );
  });
});

describe(testName('unit', 'seedGraph refusals'), () => {
  const codes = entity('sg_codes', {
    columns: { id: uuid().primaryKey(), code: text({ max: 12 }) },
    invariants: (c) => [invariant('sg_code_shape', c.code.matches(/^ZZ[0-9]{9}Q$/))],
  });

  test('a CHECK no generated value meets refuses, naming the column the factory must fill', () => {
    let caught: unknown;
    try {
      seedGraph({ codes });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_SEED_GRAPH_UNSATISFIED');
    expect(caught).toMatchObject({ fix: expect.stringContaining('code: …') });
    expect(caught).toMatchObject({ cause: expect.stringContaining('sg_code_shape') });
  });

  test('a registered factory wins, and then the table seeds', () => {
    const factory = defineFactory(codes, {
      defaults: (index, ids) => ({ id: ids.uuid(), code: `ZZ${String(index).padStart(9, '0')}Q` }),
    });
    const graph = seedGraph({ codes }, { factories: { sg_codes: factory } });
    expect(graph.inserts.map((row) => row.row['code'])).toEqual([
      'ZZ000000001Q',
      'ZZ000000002Q',
      'ZZ000000003Q',
    ]);
  });

  test('a reference to an entity outside the set refuses when the key is not nullable', () => {
    expect(() => seedGraph({ posts })).toThrow(
      expect.objectContaining({ code: 'X_SEED_GRAPH_UNSATISFIED' }),
    );
  });

  test('a tenant column whose target is outside the set refuses up front, like any reference', () => {
    let caught: unknown;
    try {
      seedGraph({ members });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_SEED_GRAPH_UNSATISFIED');
    expect(caught).toMatchObject({
      cause: expect.stringContaining('orgId references sg_orgs, which is not in the set'),
    });
  });

  test('a unique that runs out before a later tenant holds a row refuses, naming the column', () => {
    const seats = entity('sg_seats', {
      columns: {
        id: uuid().primaryKey(),
        orgId: uuid()
          .references(() => orgs.id)
          .tenant(),
        seat: enumerated(['a', 'b'] as const).unique(),
      },
    });
    let caught: unknown;
    try {
      seedGraph({ orgs, seats }, { tenants: 2, perTable: 3 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_SEED_GRAPH_UNSATISFIED');
    expect(caught).toMatchObject({
      cause: expect.stringContaining('before tenant 2 of 2 holds a row'),
      fix: expect.stringContaining('seat: …'),
    });
  });

  test('a count that is not a whole positive number, or a seed that is not finite, refuses', () => {
    expect(() => seedGraph(schema, { perTable: 0 })).toThrow(/perTable/);
    expect(() => seedGraph(schema, { tenants: 1.5 })).toThrow(/tenants/);
    expect(() => seedGraph(schema, { seed: Number.NaN })).toThrow(/seed/);
  });
});
