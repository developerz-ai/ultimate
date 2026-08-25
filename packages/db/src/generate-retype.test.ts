// The PLAN a retype produces when something is written against the column — the statement order
// that makes `generate-retype.live.test.ts` apply, asserted without a server so the gate's `unit`
// step catches a regression too. What the server does with these statements is that file's job;
// what this one pins is that each statement is emitted exactly once and in the only order that
// works: drop the dependents, ALTER, and let the ordinary diff put back what it still declares.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'text',
  notNull: false,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const FEED = {
  name: 'posts_feed_idx',
  columns: ['org_id'],
  unique: false,
  where: "status = 'published'",
  order: null,
} as const;

const COHERENT = {
  name: 'publish_coherent',
  kind: 'check',
  message: 'coherent',
  sql: "status <> 'published' or org_id is not null",
  where: null,
} as const;

const posts = (
  kind: string,
  overrides: Partial<EntityDescriptionLike> = {},
): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('org_id', { kind: 'uuid', notNull: true }),
    column('status', { kind, notNull: true }),
  ],
  indexes: [FEED],
  invariants: [COHERENT],
  ...overrides,
});

const at = new Date('2026-08-25T00:00:00.000Z');

const upOf = (entity: EntityDescriptionLike, current: EntityDescriptionLike): readonly string[] =>
  generateMigration({
    entities: [entity],
    current: snapshotOf([current]),
    name: 'status to text',
    now: at,
  }).up.split('\n');

describe('a retype whose column a predicate reads', () => {
  test('drops the dependent index and constraint BEFORE the ALTER, and recreates the index after', () => {
    const up = upOf(posts('text'), posts('post_status'));
    expect(up).toEqual([
      'drop index "posts_feed_idx";',
      'alter table "posts" drop constraint "posts_publish_coherent_check";',
      'alter table "posts" alter column "status" type text using "status"::text;',
      `create index "posts_feed_idx" on "posts" ("org_id") where (status = 'published');`,
      'alter table "posts" add constraint "posts_publish_coherent_check" ' +
        `check (status <> 'published' or org_id is not null);`,
    ]);
  });

  test('the declared index is CREATED, never compared — a definition that never moved emits nothing', () => {
    // The index loop's ordinary arm is `redefineIndex`, which is silent when the shape is
    // identical. Silent here means the table comes out of the migration with no index at all,
    // because the statement three lines up already dropped it.
    const up = upOf(posts('text'), posts('post_status'));
    expect(up.filter((line) => line.startsWith('create index'))).toHaveLength(1);
    expect(up.filter((line) => line.startsWith('drop index'))).toHaveLength(1);
  });

  test('the constraint is dropped ONCE — a second drop of the same name is 42704', () => {
    const up = upOf(posts('text'), posts('post_status'));
    const drops = up.filter((line) => line.includes('drop constraint'));
    expect(drops).toEqual(['alter table "posts" drop constraint "posts_publish_coherent_check";']);
    // The bare add, never `drop constraint if exists` + add: this plan dropped the name itself, so
    // it is provably free and the pair would only read as a repair of something.
    expect(up.filter((line) => line.includes('drop constraint if exists'))).toEqual([]);
  });

  test('a constraint the entity NO LONGER declares is dropped and not added back', () => {
    // `examples/dummy`'s shape: the CHECK is recorded, the entity now states the rule as an
    // `assert`, and the retype is what forces the drop to happen early. Nothing may re-add it, and
    // nothing may drop it twice.
    const up = upOf(posts('text', { invariants: [] }), posts('post_status'));
    expect(up).toEqual([
      'drop index "posts_feed_idx";',
      'alter table "posts" drop constraint "posts_publish_coherent_check";',
      'alter table "posts" alter column "status" type text using "status"::text;',
      `create index "posts_feed_idx" on "posts" ("org_id") where (status = 'published');`,
    ]);
  });

  test('an index the entity NO LONGER declares is dropped and not restored', () => {
    // It cannot survive the ALTER, so the choice is only whether the migration says so. It does —
    // the same direction `checkPlan` takes for a recorded check nothing declares.
    const up = upOf(posts('text', { indexes: [] }), posts('post_status'));
    expect(up.filter((line) => line.includes('posts_feed_idx'))).toEqual([
      'drop index "posts_feed_idx";',
    ]);
  });

  test('the down is the mirror: the new predicates come off, the type goes back, then the old ones', () => {
    const migration = generateMigration({
      entities: [posts('text')],
      current: snapshotOf([posts('post_status')]),
      name: 'status to text',
      now: at,
    });
    expect(migration.down.split('\n')).toEqual([
      'alter table "posts" drop constraint "posts_publish_coherent_check";',
      'drop index "posts_feed_idx";',
      'alter table "posts" alter column "status" type post_status using "status"::post_status;',
      'alter table "posts" add constraint "posts_publish_coherent_check" ' +
        `check (status <> 'published' or org_id is not null);`,
      `create index "posts_feed_idx" on "posts" ("org_id") where (status = 'published');`,
    ]);
  });

  test('a retype with nothing written against the column is one statement, as it always was', () => {
    const plain = (kind: string): EntityDescriptionLike =>
      posts(kind, { indexes: [], invariants: [] });
    expect(upOf(plain('text'), plain('post_status'))).toEqual([
      'alter table "posts" alter column "status" type text using "status"::text;',
    ]);
  });

  test('a column NOT being retyped moves nothing, even when a predicate reads it', () => {
    // `org_id` is in the feed index's column list and in the constraint's expression, and neither
    // may be touched because nothing about `org_id` changed.
    expect(upOf(posts('post_status'), posts('post_status')).join('\n')).toBe('');
  });
});
