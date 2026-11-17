// A column becoming NOT NULL, as `x db gen` writes it: the snapshot each file records says what that
// file's SQL leaves behind, and the `set not null` is written, online, never left as a comment.
// Before this, the expand file's snapshot claimed NOT NULL over a nullable `add column`, so every
// database that ran it — a fresh one included — failed `x db migrate` with `X_DB_DRIFT`, and the
// next `x db gen` found nothing to generate.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { type GeneratedMigration, generateMigration, snapshotOf } from './generate';
import type { SchemaDescription } from './introspect';
import { lockHeavyStatements } from './migration-lock-lint';
import { notNullCheckName } from './not-null-contract';

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

const id = column('id', { kind: 'uuid', primaryKey: true, notNull: true });

const posts = (...extra: readonly ColumnDescriptionLike[]): EntityDescriptionLike => ({
  name: 'Post',
  table: 'posts',
  primaryKey: ['id'],
  columns: [id, column('title', { notNull: true }), ...extra],
  indexes: [],
});

const REQUIRED = column('summary', { notNull: true });

const gen = (now: EntityDescriptionLike, current: SchemaDescription): GeneratedMigration =>
  generateMigration({
    entities: [now],
    current,
    name: 'record summary',
    now: new Date('2026-11-17T00:00:00.000Z'),
  });

const nullable = (snapshot: SchemaDescription, name: string): boolean | undefined =>
  snapshot.tables[0]?.columns.find((each) => each.name === name)?.nullable;

describe('a NOT NULL column added with no default', () => {
  const migration = gen(posts(REQUIRED), snapshotOf([posts()]));

  test('the expand file adds it nullable and its snapshot says nullable — what its SQL left', () => {
    expect(migration.up).toContain('alter table "posts" add column "summary" text;');
    expect(migration.transactional).toBe(true);
    expect(nullable(migration.snapshot, 'summary')).toBe(true);
  });

  test('the contract is written in the same run, in the follow-up step, never as a comment', () => {
    const contract = migration.followUp;
    if (contract === undefined) return expect.unreachable('no contract step was written');
    expect(contract.transactional).toBe(false);
    const check = `"${notNullCheckName('posts', 'summary')}"`;
    const statements = contract.up.split('\n').filter((line) => !line.startsWith('--'));
    expect(statements).toEqual([
      `alter table "posts" drop constraint if exists ${check};`,
      `alter table "posts" add constraint ${check} check ("summary" is not null) not valid;`,
      `alter table "posts" validate constraint ${check};`,
      'alter table "posts" alter column "summary" set not null;',
      `alter table "posts" drop constraint if exists ${check};`,
    ]);
    expect(nullable(contract.snapshot, 'summary')).toBe(false);
    expect(contract.down.split('\n')).toEqual([
      'alter table "posts" alter column "summary" drop not null;',
      `alter table "posts" drop constraint if exists ${check};`,
    ]);
  });

  test('the contract tells a reader with NULL rows what to run, and no line is a bare note', () => {
    expect(migration.up).not.toContain('-- backfill');
    expect(migration.followUp?.up).toContain('then x db migrate');
  });

  test('neither file is X_MIGRATION_LOCK_HEAVY: the set not null follows its validated check', () => {
    expect(lockHeavyStatements(migration.up)).toEqual([]);
    expect(lockHeavyStatements(migration.followUp?.up ?? '')).toEqual([]);
  });

  test('the next x db gen over the contract snapshot has nothing left to write', () => {
    const contract = migration.followUp?.snapshot ?? { tables: [] };
    const again = gen(posts(REQUIRED), contract);
    expect(again.up.trim()).toBe('');
    expect(again.followUp).toBeUndefined();
  });

  test('a migration whose expand file alone is recorded still owes the contract', () => {
    // The ledger holds the transactional step and not the follow-up: a contract that failed on a
    // NULL row. Generation reads that snapshot as nullable, so it writes the contract again.
    const again = gen(posts(REQUIRED), migration.snapshot);
    expect(again.up).toContain('alter table "posts" alter column "summary" set not null;');
  });
});

describe('an existing nullable column turned NOT NULL', () => {
  const migration = gen(posts(REQUIRED), snapshotOf([posts(column('summary'))]));

  test('is the contract alone: one non-transactional file whose snapshot says not null', () => {
    expect(migration.transactional).toBe(false);
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toContain('alter table "posts" alter column "summary" set not null;');
    expect(migration.up).not.toContain('-- backfill');
    expect(nullable(migration.snapshot, 'summary')).toBe(false);
    expect(lockHeavyStatements(migration.up)).toEqual([]);
  });

  test('beside another change, the expand file records it nullable until the contract runs', () => {
    const both = gen(posts(REQUIRED, column('teaser')), snapshotOf([posts(column('summary'))]));
    expect(both.up).toContain('add column "teaser" text;');
    expect(nullable(both.snapshot, 'summary')).toBe(true);
    expect(nullable(both.followUp?.snapshot ?? { tables: [] }, 'summary')).toBe(false);
  });
});

describe('a column a primary key makes NOT NULL', () => {
  test('owes no contract: the key itself is the constraint', () => {
    const keyed: EntityDescriptionLike = {
      ...posts(),
      primaryKey: ['id', 'org_id'],
      columns: [id, column('title', { notNull: true }), column('org_id', { notNull: true })],
    };
    // An existing nullable column moving into the key: `add primary key` makes it NOT NULL. (A key
    // column ADDED with no default is refused outright, by `addChangedKey`.)
    const migration = gen(keyed, snapshotOf([posts(column('org_id'))]));
    expect(migration.up).toContain('primary key ("id", "org_id");');
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).not.toContain('set not null');
  });
});

describe('the transient check name', () => {
  test('is the convention while it fits, and a stable short name past 63 bytes', () => {
    expect(notNullCheckName('posts', 'summary')).toBe('posts_summary_not_null_check');
    const long = notNullCheckName('t'.repeat(40), 'c'.repeat(30));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(63);
    expect(notNullCheckName('t'.repeat(40), 'c'.repeat(30))).toBe(long);
    expect(notNullCheckName('t'.repeat(40), 'd'.repeat(30))).not.toBe(long);
  });
});
