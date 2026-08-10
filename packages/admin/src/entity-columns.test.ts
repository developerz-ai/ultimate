// Driven with entities built by `entity()`, never a hand-written stand-in: the shape this
// projection reads is exactly the shape the bug was — a fixture in the admin's own vocabulary
// would pass whatever @ultimat3/entity did next.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  boolean,
  clearRegistry,
  entity,
  enumerated,
  integer,
  money,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { type AdminColumnFacts, adminColumnsOf } from './entity-columns';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminEntity } from './registry';

const orgs = entity('admin_col_org', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});

const posts = entity('admin_col_post', {
  columns: {
    id: uuid().primaryKey(),
    ownerId: uuid().references(() => orgs.id),
    slug: text({ max: 64 }).unique(),
    body: text(),
    status: enumerated(['draft', 'published']).default('draft'),
    likeCount: integer().default(0),
    pinned: boolean(),
    price: money(),
    publishedAt: timestamp().nullable(),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
});

/** Composite: neither column says `.primaryKey()`; the entity names both. */
const plans = entity('admin_col_plan', {
  columns: {
    code: enumerated(['free', 'pro']),
    currency: enumerated(['EUR', 'USD']),
    monthly: money(),
  },
  primaryKey: ['code', 'currency'],
});

afterAll(clearRegistry);

const column = (source: AdminEntity, name: string): AdminColumnFacts | undefined =>
  adminColumnsOf(source).find((facts) => facts.name === name);

describe('a real entity projects onto the facts the admin derives from', () => {
  test('every declared column arrives, in declaration order', () => {
    expect(adminColumnsOf(posts).map((facts) => facts.name)).toEqual([
      'id',
      'ownerId',
      'slug',
      'body',
      'status',
      'likeCount',
      'pinned',
      'price',
      'publishedAt',
      'createdAt',
      'updatedAt',
    ]);
  });

  test('kinds are the entity kinds, not a SQL type name the admin invented', () => {
    expect(column(posts, 'id')?.kind).toBe('uuid');
    expect(column(posts, 'body')?.kind).toBe('text');
    expect(column(posts, 'pinned')?.kind).toBe('boolean');
    expect(column(posts, 'likeCount')?.kind).toBe('integer');
    expect(column(posts, 'price')?.kind).toBe('money');
    expect(column(posts, 'createdAt')?.kind).toBe('timestamptz');
  });

  test('keys, uniqueness, indexes and nullability come off the column metadata', () => {
    expect(column(posts, 'id')).toMatchObject({ primaryKey: true, nullable: false });
    expect(column(posts, 'slug')).toMatchObject({ unique: true, primaryKey: false });
    expect(column(posts, 'publishedAt')).toMatchObject({ nullable: true });
    // `.references()` indexes the column, which is what makes the FK a usable filter.
    expect(column(posts, 'ownerId')).toMatchObject({ index: true, nullable: false });
    expect(column(posts, 'body')).toMatchObject({ index: false, unique: false });
  });

  test('only a generated default is read-only; a literal one is a starting value', () => {
    expect(column(posts, 'id')?.generated).toBe(true);
    expect(column(posts, 'createdAt')?.generated).toBe(true);
    expect(column(posts, 'updatedAt')?.generated).toBe(true);
    expect(column(posts, 'status')?.generated).toBe(false);
    expect(column(posts, 'likeCount')?.generated).toBe(false);
    expect(column(posts, 'body')?.generated).toBe(false);
  });

  test('a foreign key is resolved to the entity and column it points at', () => {
    expect(column(posts, 'ownerId')?.references).toEqual({
      entity: 'admin_col_org',
      column: 'id',
    });
    expect(column(posts, 'slug')?.references).toBeUndefined();
  });

  test('a bounded text column carries its length; an unbounded one is prose', () => {
    expect(column(posts, 'slug')?.length).toBe(64);
    expect(column(posts, 'body')?.length).toBeUndefined();
  });

  test('a closed set of values travels, so the widget can be a select', () => {
    expect(column(posts, 'status')?.values).toEqual(['draft', 'published']);
    expect(column(posts, 'body')?.values).toBeUndefined();
  });

  test('money stays one property, not the two physical columns a migration emits', () => {
    const names = adminColumnsOf(posts).map((facts) => facts.name);
    expect(names).toContain('price');
    expect(names).not.toContain('priceMinor');
    expect(names).not.toContain('priceCurrency');
  });

  test('a composite key marks every member, so none of them is editable', () => {
    expect(adminColumnsOf(plans).map((facts) => facts.name)).toEqual([
      'code',
      'currency',
      'monthly',
    ]);
    expect(column(plans, 'code')?.primaryKey).toBe(true);
    expect(column(plans, 'currency')?.primaryKey).toBe(true);
    expect(column(plans, 'monthly')?.primaryKey).toBe(false);
  });
});

describe('a reference the binding could not resolve', () => {
  /** Only reachable from a hand-written surface — which is exactly why it is checked. */
  const broken: AdminEntity = {
    $name: 'admin_col_broken',
    $primaryKey: ['id'],
    $columns: {
      id: {
        $meta: { kind: 'uuid', notNull: true, primaryKey: true, unique: false, index: false },
      },
    },
    $schema: undefined,
    $describe: () => ({ columns: [{ property: 'id', references: 'orphan' }] }),
  };

  test('fails with the fix line instead of rendering a link to nowhere', () => {
    expect(() => adminColumnsOf(broken)).toThrow(AdminFieldUnsupportedError);
    try {
      adminColumnsOf(broken);
    } catch (error) {
      const thrown = error as { code: string; fix: string };
      expect(thrown.code).toBe('X_ADMIN_FIELD_UNSUPPORTED');
      expect(thrown.fix).toContain('entity()');
    }
  });
});
