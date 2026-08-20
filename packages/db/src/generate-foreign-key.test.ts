// The half of `x db gen` a wrong answer makes unapplicable: a foreign key is a statement of its
// own, after every table exists. Registration order is the app's import order and has nothing to
// say about which table a `references()` points at. Split from `generate.test.ts` for the ceiling.

import { describe, expect, test } from 'bun:test';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration, snapshotOf } from './generate';
import { statementsOf } from './statement-split';

const column = (
  name: string,
  overrides: Partial<ColumnDescriptionLike> = {},
): ColumnDescriptionLike => ({
  property: name,
  column: name,
  kind: 'uuid',
  notNull: true,
  primaryKey: false,
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
  ...overrides,
});

const table = (name: string, columns: readonly ColumnDescriptionLike[]): EntityDescriptionLike => ({
  name,
  table: name,
  primaryKey: ['id'],
  columns: [column('id', { primaryKey: true }), ...columns],
  indexes: [],
});

const at = new Date('2026-08-17T12:00:00.000Z');

/** The defect exactly: the child is registered first, so it was created first, with an inline FK. */
const childFirst: readonly EntityDescriptionLike[] = [
  table('comments', [column('post_id', { references: 'posts.id' })]),
  table('posts', []),
];

const indexOfStatement = (statements: readonly string[], needle: string): number =>
  statements.findIndex((statement) => statement.includes(needle));

describe('unit · foreign keys are their own statements, after every table', () => {
  test('a child registered before its parent still creates the parent first', () => {
    // Reproduced against PGlite before the fix: `relation "posts" does not exist`, statement one.
    const statements = statementsOf(
      generateMigration({ entities: childFirst, name: 'x', now: at }).up,
    );
    const parent = indexOfStatement(statements, 'create table "posts"');
    const constraint = indexOfStatement(statements, 'add constraint "comments_post_id_fkey"');
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(constraint).toBeGreaterThan(parent);
  });

  test('no create table carries an inline references clause', () => {
    const statements = statementsOf(
      generateMigration({ entities: childFirst, name: 'x', now: at }).up,
    );
    const creates = statements.filter((statement) => statement.startsWith('create table'));
    expect(creates.length).toBe(2);
    expect(creates.some((statement) => statement.includes('references'))).toBe(false);
  });

  test('the constraint the snapshot records is the constraint the statement names', () => {
    const migration = generateMigration({ entities: childFirst, name: 'x', now: at });
    const recorded = migration.snapshot.tables.find((each) => each.name === 'comments');
    const name = recorded?.foreignKeys[0]?.name ?? '';
    expect(name).toBe('comments_post_id_fkey');
    expect(migration.up).toContain(
      `alter table "comments" add constraint "${name}" foreign key ("post_id") ` +
        'references "posts" ("id");',
    );
  });

  test('down drops every constraint before it drops any table', () => {
    // `drop table "posts"` with `comments` still referencing it is `2BP01`, so a `down` that
    // reverses tables alone is a migration that cannot be rolled back at all.
    const statements = statementsOf(
      generateMigration({ entities: childFirst, name: 'x', now: at }).down,
    );
    const constraint = indexOfStatement(statements, 'drop constraint "comments_post_id_fkey"');
    const firstDrop = indexOfStatement(statements, 'drop table');
    expect(constraint).toBe(0);
    expect(firstDrop).toBeGreaterThan(constraint);
  });

  test('two tables referencing each other generate rather than throwing on the cycle', () => {
    // Inline `references` cannot express a cycle at all, whatever order the tables are sorted in.
    const cyclic = [
      table('users', [column('org_id', { references: 'orgs.id' })]),
      table('orgs', [column('owner_id', { references: 'users.id' })]),
    ];
    const statements = statementsOf(generateMigration({ entities: cyclic, name: 'x', now: at }).up);
    const creates = statements.filter((statement) => statement.startsWith('create table')).length;
    const adds = statements.filter((statement) => statement.includes('add constraint')).length;
    expect({ creates, adds }).toEqual({ creates: 2, adds: 2 });
  });

  test('a self-reference is one table and one constraint', () => {
    const tree = [
      table('nodes', [column('parent_id', { references: 'nodes.id', notNull: false })]),
    ];
    const statements = statementsOf(generateMigration({ entities: tree, name: 'x', now: at }).up);
    expect(statements.filter((each) => each.startsWith('create table')).length).toBe(1);
    expect(statements.some((each) => each.includes('add constraint "nodes_parent_id_fkey"'))).toBe(
      true,
    );
  });
});

describe('unit · a references() added to a column that already exists', () => {
  const before = [table('comments', [column('post_id')]), table('posts', [])];
  const after = [
    table('comments', [column('post_id', { references: 'posts.id' })]),
    table('posts', []),
  ];

  test('emits the add constraint the snapshot beside it already claimed', () => {
    // Before: `up` was empty, so `x db gen` wrote no file, the entity hash still moved, and
    // `x verify`'s drift step stayed red with `x db gen "…"` as a fix that does nothing.
    const migration = generateMigration({
      entities: after,
      current: snapshotOf(before),
      name: 'add fk',
      now: at,
    });
    expect(migration.up).toContain(
      'alter table "comments" add constraint "comments_post_id_fkey" ' +
        'foreign key ("post_id") references "posts" ("id");',
    );
    expect(migration.down).toContain(
      'alter table "comments" drop constraint "comments_post_id_fkey";',
    );
  });

  test('a key the previous snapshot already recorded is not added twice', () => {
    const migration = generateMigration({
      entities: after,
      current: snapshotOf(after),
      name: 'no change',
      now: at,
    });
    expect(migration.up.trim()).toBe('');
  });

  test('a key held under another constraint name is matched by where it points', () => {
    // A hand-written migration may have said `constraint fk_comments_post`; the same key under
    // another name is the same key, exactly as `compareForeignKeys` in `drift.ts` reads it.
    const renamed = snapshotOf(after).tables.map((each) =>
      each.name === 'comments'
        ? { ...each, foreignKeys: each.foreignKeys.map((key) => ({ ...key, name: 'fk_legacy' })) }
        : each,
    );
    const migration = generateMigration({
      entities: after,
      current: { tables: renamed },
      name: 'no change',
      now: at,
    });
    expect(migration.up.trim()).toBe('');
  });
});

describe('unit · a references() removed from a column that keeps existing', () => {
  const before = [
    table('comments', [column('post_id', { references: 'posts.id' })]),
    table('posts', []),
  ];
  const after = [table('comments', [column('post_id')]), table('posts', [])];

  test('drops the constraint the previous snapshot recorded', () => {
    // Before: `up` and `down` were both empty and the new snapshot recorded `foreignKeys: []`, so
    // the orphan constraint stayed on the database AND the snapshot beside it denied one the
    // catalog holds — `compareForeignKeys` judges the declared side, so drift could never see it.
    const migration = generateMigration({
      entities: after,
      current: snapshotOf(before),
      name: 'drop fk',
      now: at,
    });
    expect(migration.up).toContain(
      'alter table "comments" drop constraint "comments_post_id_fkey";',
    );
    expect(migration.down).toContain(
      'alter table "comments" add constraint "comments_post_id_fkey" ' +
        'foreign key ("post_id") references "posts" ("id");',
    );
  });

  test('drops it under the name the snapshot recorded, not the name entity would have chosen', () => {
    // `drop constraint` names a constraint, so the name must come from the side that has one —
    // a hand-written migration's `fk_legacy` is `42704` under the generated spelling.
    const renamed = snapshotOf(before).tables.map((each) =>
      each.name === 'comments'
        ? { ...each, foreignKeys: each.foreignKeys.map((key) => ({ ...key, name: 'fk_legacy' })) }
        : each,
    );
    const migration = generateMigration({
      entities: after,
      current: { tables: renamed },
      name: 'drop fk',
      now: at,
    });
    expect(migration.up).toContain('alter table "comments" drop constraint "fk_legacy";');
  });

  test('a column dropped with its references() emits no second drop constraint', () => {
    // `drop column` takes the constraint with it, so a `drop constraint` after it is `42704` on a
    // constraint that is already gone. The guard is the column list, not `if exists`.
    const migration = generateMigration({
      entities: [table('comments', []), table('posts', [])],
      current: snapshotOf(before),
      name: 'drop column',
      now: at,
      allowDestructive: true,
    });
    expect(migration.up).toContain('alter table "comments" drop column "post_id";');
    expect(migration.up).not.toContain('drop constraint');
  });
});

describe('unit · the on delete rule the entity declared', () => {
  const cascading = [
    table('comments', [column('post_id', { references: 'posts.id', onDelete: 'cascade' })]),
    table('posts', []),
  ];

  test('reaches the statement', () => {
    const migration = generateMigration({ entities: cascading, name: 'x', now: at });
    expect(migration.up).toContain(
      'alter table "comments" add constraint "comments_post_id_fkey" ' +
        'foreign key ("post_id") references "posts" ("id") on delete cascade;',
    );
  });

  test('and the snapshot records it, so drift has something truthful to compare', () => {
    const migration = generateMigration({ entities: cascading, name: 'x', now: at });
    const recorded = migration.snapshot.tables.find((each) => each.name === 'comments');
    expect(recorded?.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  const before = [
    table('comments', [column('post_id', { references: 'posts.id' })]),
    table('posts', []),
  ];

  test('a rule added to a key that already exists rebuilds the constraint', () => {
    // The key points the same way, so `foreignKeyTarget` matches and nothing is *added* — but a
    // migration that emitted nothing here would write a snapshot claiming a cascade the database
    // does not have, which is the same lie a removed `references()` used to tell. Postgres has no
    // `alter constraint` for the rule, so it is a rebuild, exactly like `redefineIndex`.
    const migration = generateMigration({
      entities: cascading,
      current: snapshotOf(before),
      name: 'cascade it',
      now: at,
    });
    // `statementsOf` is the splitter `migrate()` applies, so these are the sends, terminator off.
    expect(statementsOf(migration.up)).toEqual([
      'alter table "comments" drop constraint "comments_post_id_fkey"',
      'alter table "comments" add constraint "comments_post_id_fkey" foreign key ("post_id") ' +
        'references "posts" ("id") on delete cascade',
    ]);
    // Read backwards: drop what this migration created, then put the recorded rule back.
    expect(statementsOf(migration.down)).toEqual([
      'alter table "comments" drop constraint "comments_post_id_fkey"',
      'alter table "comments" add constraint "comments_post_id_fkey" foreign key ("post_id") ' +
        'references "posts" ("id")',
    ]);
    const recorded = migration.snapshot.tables.find((each) => each.name === 'comments');
    expect(recorded?.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  test('the same rule under both spellings is not a rebuild', () => {
    // A snapshot introspected off the catalog holds `c`; the entity declares `cascade`.
    const catalogSpelling = snapshotOf(cascading).tables.map((each) =>
      each.name === 'comments'
        ? { ...each, foreignKeys: each.foreignKeys.map((key) => ({ ...key, onDelete: 'c' })) }
        : each,
    );
    const migration = generateMigration({
      entities: cascading,
      current: { tables: catalogSpelling },
      name: 'no change',
      now: at,
    });
    expect(migration.up.trim()).toBe('');
  });
});
