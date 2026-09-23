// An entity's client identity — its record type and its record key — derived from the one
// declaration, and the brand on its row schema that carries both through every `t` wrapper an
// output can put around a row.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { nodeOf, t } from '@ultimat3/schema';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { ENTITY_BRAND, projectionOf, recordProjection } from './record-projection';
import { recordProjectionForTable, recordTypeForTable } from './record-table';
import { clearRegistry } from './registry';

const posts = entity('record_projection_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    likeCount: integer().default(0),
  },
});

const memberships = entity('record_projection_memberships', {
  columns: {
    orgId: uuid(),
    userId: uuid(),
    role: text({ max: 20 }),
  },
  primaryKey: ['orgId', 'userId'],
});

afterAll(() => {
  clearRegistry();
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const USER = '00000000-0000-7000-8000-0000000000b2';

/** The refusal a key function raises, or the test's own verdict when it raises nothing. */
const refusalOf = (run: () => unknown): { code: string; cause: string; fix: string } => {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable('the key function threw something other than an UltimateError');
  }
  return expect.unreachable('the key function accepted a row with no key');
};

describe('recordProjection()', () => {
  test('the record type is the entity name, and persist defaults to false', () => {
    const projection = recordProjection(posts);
    expect(projection.type).toBe('record_projection_posts');
    expect(projection.persist).toBe(false);
  });

  test('persist: true on the declaration reaches the projection, and only true does', () => {
    const drafts = entity('record_projection_drafts', {
      columns: { id: uuid().primaryKey() },
      persist: true,
    });
    expect(recordProjection(drafts).persist).toBe(true);
    expect(recordProjection(posts).persist).toBe(false);
  });

  test('a single key is the column value itself, so it matches $tagFor(id)', () => {
    const id = '00000000-0000-7000-8000-000000000001';
    expect(recordProjection(posts).key({ id, title: 'x', likeCount: 0 })).toBe(id);
  });

  test('a composite key is stable across the row’s own key order', () => {
    const { key } = recordProjection(memberships);
    const forwards = key({ orgId: ORG, userId: USER, role: 'owner' });
    const backwards = key({ role: 'owner', userId: USER, orgId: ORG });
    expect(forwards).toBe(backwards);
    // Declared order, not row order: swapping the VALUES is a different record.
    expect(key({ orgId: USER, userId: ORG, role: 'owner' })).not.toBe(forwards);
  });

  test('a composite part carrying the separator cannot collide with another split', () => {
    const { key } = recordProjection(memberships);
    expect(key({ orgId: 'a:b', userId: 'c', role: 'r' })).not.toBe(
      key({ orgId: 'a', userId: 'b:c', role: 'r' }),
    );
  });

  test('a row missing its key is X_RECORD_KEY_MISSING, naming the column', () => {
    const refusal = refusalOf(() => recordProjection(memberships).key({ orgId: ORG, role: 'r' }));
    expect(refusal.code).toBe('X_RECORD_KEY_MISSING');
    expect(refusal.cause).toContain('userId');
    expect(refusal.fix).toContain('x entities describe record_projection_memberships');
  });

  test('a null key and a non-scalar key are refused the same way', () => {
    const { key } = recordProjection(posts);
    expect(refusalOf(() => key({ id: null, title: 'x' })).code).toBe('X_RECORD_KEY_MISSING');
    const nested = refusalOf(() => key({ id: { secret: 'sk-live-1' }, title: 'x' }));
    expect(nested.code).toBe('X_RECORD_KEY_MISSING');
    // Shape, never content: the key value is the caller's data.
    expect(nested.cause).not.toContain('sk-live-1');
  });

  test('an inherited member is not a key', () => {
    const inherited = Object.create({ id: 'from-the-prototype' }) as Record<string, unknown>;
    expect(refusalOf(() => recordProjection(posts).key(inherited)).code).toBe(
      'X_RECORD_KEY_MISSING',
    );
  });

  test('the projection is JSON-safe: no function beyond key', () => {
    const projection = recordProjection(memberships);
    const functions = Object.entries(projection).filter(([, v]) => typeof v === 'function');
    expect(functions.map(([name]) => name)).toEqual(['key']);
    const wire = JSON.parse(JSON.stringify(projection));
    expect(wire.type).toBe('record_projection_memberships');
    expect(wire.persist).toBe(false);
    expect(wire.schema.kind).toBe('object');
    expect(Object.keys(wire.schema.properties).sort()).toEqual(['orgId', 'role', 'userId']);
  });
});

describe('the row-schema brand', () => {
  const brandOf = (schema: unknown) => projectionOf(nodeOf(schema));

  test('the entity row schema carries its projection, non-enumerably', () => {
    const node = nodeOf(posts.$schema);
    expect(brandOf(posts.$schema)).toBe(recordProjection(posts));
    const descriptor =
      node === undefined ? undefined : Object.getOwnPropertyDescriptor(node, ENTITY_BRAND);
    expect(descriptor?.enumerable).toBe(false);
    // Non-enumerable is what keeps it out of every spread, `toEqual` and IR comparison.
    expect(Object.getOwnPropertySymbols({ ...node })).toEqual([]);
    expect(JSON.stringify(node)).not.toContain('record_projection_posts');
    // `Symbol.for`, so a brand minted by another bundle's copy of this module is the same key.
    expect(ENTITY_BRAND === Symbol.for('ultimate.entity')).toBe(true);
  });

  test('survives every wrapper an output can put around a row', () => {
    const projection = recordProjection(posts);
    const wrapped = {
      'nullable()': posts.$schema.nullable(),
      't.nullable': t.nullable(posts.$schema),
      'optional()': posts.$schema.optional(),
      't.optional': t.optional(posts.$schema),
      'nullable().optional()': posts.$schema.nullable().optional(),
      'describe()': posts.$schema.describe('a post'),
    };
    for (const [how, schema] of Object.entries(wrapped)) {
      expect({ how, brand: brandOf(schema) }).toEqual({ how, brand: projection });
    }
    // Containers keep the child node by reference, so the brand is one hop down.
    expect(projectionOf(nodeOf(t.array(posts.$schema))?.items)).toBe(projection);
    expect(projectionOf(nodeOf(t.object({ post: posts.$schema }))?.properties?.['post'])).toBe(
      projection,
    );
    expect(projectionOf(nodeOf(t.union(t.string, posts.$schema))?.anyOf?.[1])).toBe(projection);
  });

  test('the brand does not leak onto the unwrapped schema’s siblings', () => {
    expect(brandOf(t.object({ id: t.uuid }))).toBeUndefined();
    expect(brandOf(posts.$view(['id', 'title']))).toBeUndefined();
  });

  test('the row schema still validates as a Standard Schema', () => {
    const ok = posts.$schema['~standard'].validate({
      id: '00000000-0000-7000-8000-000000000001',
      title: 'x',
    });
    expect(ok instanceof Promise ? undefined : ok.issues).toBeUndefined();
    const bad = posts.$schema['~standard'].validate({ id: 7 });
    expect(bad instanceof Promise ? [] : bad.issues?.length).toBeGreaterThan(0);
  });
});

describe('recordTypeForTable()', () => {
  test('maps the physical relation back to the record type, renamed tables included', () => {
    const accounts = entity('record_projection_account', {
      table: 'legacy_accounts',
      columns: { id: uuid().primaryKey() },
    });
    expect(recordProjection(accounts).table).toBe('legacy_accounts');
    expect(recordTypeForTable('legacy_accounts')).toBe('record_projection_account');
    expect(recordTypeForTable('record_projection_posts')).toBe('record_projection_posts');
    expect(recordTypeForTable('no_such_table')).toBeUndefined();
  });

  test('recordProjectionForTable answers the whole projection, from the same index', () => {
    const notes = entity('record_projection_note', {
      table: 'legacy_notes',
      persist: true,
      columns: { id: uuid().primaryKey() },
    });
    expect(recordProjectionForTable('legacy_notes')).toBe(recordProjection(notes));
    expect(recordProjectionForTable('legacy_notes')?.persist).toBe(true);
    expect(recordProjectionForTable('no_such_table')).toBeUndefined();
  });

  test('two entities over one table have no single record type, and say so', () => {
    entity('record_projection_shared_a', {
      table: 'rp_shared',
      columns: { id: uuid().primaryKey() },
    });
    entity('record_projection_shared_b', {
      table: 'rp_shared',
      columns: { id: uuid().primaryKey() },
    });
    expect(refusalOf(() => recordTypeForTable('rp_shared')).code).toBe('X_INVARIANT_VIOLATED');
  });
});

describe('X_RECORD_KEY_MISSING’s fix', () => {
  test('an entity name carrying shell syntax degrades to prose, never a command', () => {
    const hostile = entity('rp_$(touch pwned)', {
      table: 'rp_hostile',
      columns: { id: uuid().primaryKey() },
    });
    const refusal = refusalOf(() => recordProjection(hostile).key({}));
    expect(refusal.code).toBe('X_RECORD_KEY_MISSING');
    expect(refusal.fix).not.toContain('$(');
    expect(refusal.fix).toContain('x entities list --json');
  });
});
