// An existing column whose DEFAULT or NULLABILITY moved. Before `column-alter.ts` each of these
// generated an empty `up` while the snapshot recorded the move, so `x verify` reported
// `X_DB_SCHEMA_UNMIGRATED` and `x db gen`, its own fix, wrote nothing — red forever.

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

const posts = (status: Partial<ColumnDescriptionLike>): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [
    column('id', { kind: 'uuid', primaryKey: true, notNull: true }),
    column('status', status),
  ],
  indexes: [],
});

const draft = { hasDefault: true, default: { kind: 'value', value: 'draft' } } as const;

const diff = (now: EntityDescriptionLike, before: EntityDescriptionLike) =>
  generateMigration({
    entities: [now],
    current: snapshotOf([before]),
    name: 'status',
    now: new Date('2026-09-23T00:00:00.000Z'),
  });

const lines = (script: string): readonly string[] =>
  script.split('\n').filter((line) => line.includes('"status"'));

describe('a default that moves on an existing column', () => {
  test('a new default is set, and down drops it', () => {
    const { up, down } = diff(posts(draft), posts({}));
    expect(lines(up)).toEqual([`alter table "posts" alter column "status" set default 'draft';`]);
    expect(lines(down)).toEqual(['alter table "posts" alter column "status" drop default;']);
  });

  test('a changed default is set to the new value, and down restores the old one', () => {
    const published = { hasDefault: true, default: { kind: 'value', value: 'live' } } as const;
    const { up, down } = diff(posts(published), posts(draft));
    expect(lines(up)).toEqual([`alter table "posts" alter column "status" set default 'live';`]);
    expect(lines(down)).toEqual([`alter table "posts" alter column "status" set default 'draft';`]);
  });

  test('a removed default is dropped, and down restores it', () => {
    const { up, down } = diff(posts({}), posts(draft));
    expect(lines(up)).toEqual(['alter table "posts" alter column "status" drop default;']);
    expect(lines(down)).toEqual([`alter table "posts" alter column "status" set default 'draft';`]);
  });

  test('a default this generator cannot render drops nothing the database holds', () => {
    expect(lines(diff(posts({ hasDefault: true }), posts(draft)).up)).toEqual([]);
  });

  test('a recorded default carrying a second command is refused, never spliced into down', () => {
    const tampered = snapshotOf([posts(draft)]);
    const table = tampered.tables[0];
    const forged = {
      tables: [
        {
          ...(table ?? {
            schema: 'public',
            name: 'posts',
            primaryKey: [],
            indexes: [],
            foreignKeys: [],
          }),
          columns: (table?.columns ?? []).map((c) =>
            c.name === 'status' ? { ...c, default: "'x'; drop table users; --" } : c,
          ),
        },
      ],
    };
    expect(() => generateMigration({ entities: [posts({})], current: forged, name: 'x' })).toThrow(
      'X_SQL_UNSAFE',
    );
  });
});

describe('nullability that moves on an existing column', () => {
  test('becoming nullable is drop not null, and down sets it back', () => {
    const { up, down } = diff(posts({}), posts({ notNull: true }));
    expect(lines(up)).toEqual(['alter table "posts" alter column "status" drop not null;']);
    expect(lines(down)).toEqual(['alter table "posts" alter column "status" set not null;']);
  });

  test('becoming NOT NULL is the backfill note, never a bare set not null that fails on NULL rows', () => {
    const { up } = diff(posts({ notNull: true }), posts({}));
    expect(lines(up)).toEqual([
      '-- backfill "status", then: alter table "posts" alter column "status" set not null;',
    ]);
    expect(up.trim().length).toBeGreaterThan(0);
  });

  test('an unchanged column still generates nothing at all', () => {
    expect(diff(posts(draft), posts(draft)).up.trim()).toBe('');
  });
});
