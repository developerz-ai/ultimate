// Which phase a foreign key lands in. A key on a live table scans the table holding a lock that
// stops writes, so it goes to the deferred step as `not valid` then `validate`; a table created by
// this migration is empty and keeps the plain form its SQL has always had, byte for byte.

import { describe, expect, test } from 'bun:test';
import { generateMigration, snapshotOf } from './generate';
import { AT, tableOf, uuidColumn } from './rolling-fixture';
import { statementsOf } from './statement-split';

const posts = tableOf('posts');
const comments = (onDelete: string | null = null) =>
  tableOf('comments', [uuidColumn('post_id', { references: 'posts.id', onDelete })]);
const bareComments = tableOf('comments', [uuidColumn('post_id')]);

/** A statement past its leading comments: the first one carries the step's own marker. */
const bare = (statement: string | undefined): string =>
  (statement ?? '').replace(/^(?:--[^\n]*\n)+/, '');

const ADD_NOT_VALID =
  'alter table "comments" drop constraint if exists "comments_post_id_fkey", add constraint ' +
  '"comments_post_id_fkey" foreign key ("post_id") references "posts" ("id") not valid';
const VALIDATE = 'alter table "comments" validate constraint "comments_post_id_fkey"';

describe('foreign key phases', () => {
  test('a key added to a live table lands in the deferred step, added then validated', () => {
    const migration = generateMigration({
      entities: [comments(), posts],
      current: snapshotOf([bareComments, posts]),
      name: 'link',
      now: AT,
    });
    expect(migration.transactional).toBe(false);
    expect(statementsOf(migration.up).map(bare)).toEqual([ADD_NOT_VALID, VALIDATE]);
    expect(statementsOf(migration.down)).toEqual([
      'alter table "comments" drop constraint if exists "comments_post_id_fkey"',
    ]);
  });

  test('a new table keeps the plain transactional key, byte for byte', () => {
    const migration = generateMigration({ entities: [comments(), posts], name: 'init', now: AT });
    expect(migration.followUp).toBeUndefined();
    expect(migration.transactional).toBe(true);
    expect(migration.up).toContain(
      'alter table "comments" add constraint "comments_post_id_fkey" foreign key ("post_id") ' +
        'references "posts" ("id");',
    );
    expect(migration.up).not.toContain('not valid');
  });

  test('a new table over a target index this migration defers defers its key too', () => {
    const target = tableOf('posts', [uuidColumn('slug')]);
    const indexed = tableOf('posts', [uuidColumn('slug')], {
      indexes: [
        {
          name: 'posts_slug_key',
          columns: ['slug'],
          unique: true,
          where: null,
          order: null,
          concurrently: true,
        },
      ],
    });
    const child = tableOf('comments', [uuidColumn('post_slug', { references: 'posts.slug' })]);
    // The child comes first on purpose: the answer must not depend on registration order.
    const migration = generateMigration({
      entities: [child, indexed],
      current: snapshotOf([target]),
      name: 'link',
      now: AT,
    });
    expect(migration.up).toContain('create table "comments"');
    expect(migration.up).not.toContain('foreign key');
    expect(statementsOf(migration.followUp?.up ?? '').map(bare)).toEqual([
      'create unique index concurrently if not exists "posts_slug_key" on "posts" ("slug")',
      'alter table "comments" drop constraint if exists "comments_post_slug_fkey", add constraint ' +
        '"comments_post_slug_fkey" foreign key ("post_slug") references "posts" ("slug") not valid',
      'alter table "comments" validate constraint "comments_post_slug_fkey"',
    ]);
  });

  test('a moved on delete rule swaps the key in one statement, in the deferred step', () => {
    const migration = generateMigration({
      entities: [comments('cascade'), posts],
      current: snapshotOf([comments(), posts]),
      name: 'cascade',
      now: AT,
    });
    expect(migration.transactional).toBe(false);
    const up = statementsOf(migration.up);
    expect(up[0]).toContain(
      'drop constraint if exists "comments_post_id_fkey", add constraint "comments_post_id_fkey"',
    );
    expect(up[0]).toContain('on delete cascade not valid');
    expect(up[1]).toBe(VALIDATE);
    // Reversed: the recorded rule comes back the same way, then is validated.
    const down = statementsOf(migration.down);
    expect(down[0]).toContain('references "posts" ("id") not valid');
    expect(down[0]).not.toContain('on delete cascade');
    expect(down[1]).toBe(VALIDATE);
  });

  test('a retype re-add stays transactional: it holds ACCESS EXCLUSIVE for the rewrite already', () => {
    const textPosts = tableOf('posts', [], {
      columns: [uuidColumn('id', { primaryKey: true, kind: 'text' })],
    });
    const textComments = tableOf('comments', [
      uuidColumn('post_id', { references: 'posts.id', kind: 'text' }),
    ]);
    const migration = generateMigration({
      entities: [textComments, textPosts],
      current: snapshotOf([comments(), posts]),
      name: 'retype',
      now: AT,
      allowDestructive: true,
    });
    expect(migration.followUp).toBeUndefined();
    expect(migration.up).toContain(
      'alter table "comments" add constraint "comments_post_id_fkey" foreign key ("post_id") ' +
        'references "posts" ("id");',
    );
    expect(migration.up).not.toContain('not valid');
  });

  test('a key repointed under its own name is one swap, and no contract drops it after', () => {
    const repointed = tableOf('comments', [uuidColumn('post_id', { references: 'orgs.id' })]);
    const orgs = tableOf('orgs');
    const migration = generateMigration({
      entities: [repointed, orgs, posts],
      current: snapshotOf([comments(), orgs, posts]),
      name: 'repoint',
      now: AT,
    });
    expect(migration.transactional).toBe(false);
    expect(statementsOf(migration.up).map(bare)).toEqual([
      'alter table "comments" drop constraint if exists "comments_post_id_fkey", add constraint ' +
        '"comments_post_id_fkey" foreign key ("post_id") references "orgs" ("id") not valid',
      VALIDATE,
    ]);
  });

  test('a key repointed away from a table this migration drops claims no key to it', () => {
    const orgs = tableOf('orgs');
    const repointed = tableOf('comments', [uuidColumn('post_id', { references: 'orgs.id' })]);
    const migration = generateMigration({
      entities: [repointed, orgs],
      current: snapshotOf([comments(), orgs, posts]),
      name: 'repoint',
      now: AT,
      allowDestructive: true,
    });
    const first = migration.snapshot.tables.find((each) => each.name === 'comments');
    expect(first?.foreignKeys).toEqual([]);
    // Rolled back, the follow-up has no key to a gone table to restore: 42P01 otherwise.
    expect(migration.followUp?.down).toBe(
      'alter table "comments" drop constraint if exists "comments_post_id_fkey";',
    );
  });

  test('a recorded key another deferred key now covers is dropped in the contract, last', () => {
    const live = snapshotOf([comments(), posts]);
    const orgs = tableOf('orgs');
    const repointed = tableOf('comments', [uuidColumn('post_id', { references: 'orgs.id' })]);
    const migration = generateMigration({
      entities: [repointed, orgs, posts],
      current: {
        tables: [
          ...live.tables.map((each) =>
            each.name === 'comments'
              ? {
                  ...each,
                  // A hand-named key the entity no longer points the same way, over one column.
                  foreignKeys: each.foreignKeys.map((key) => ({ ...key, name: 'fk_legacy' })),
                }
              : each,
          ),
          ...snapshotOf([orgs]).tables,
        ],
      },
      name: 'repoint',
      now: AT,
    });
    const up = statementsOf(migration.up).map(bare);
    expect(up.at(-1)).toBe('alter table "comments" drop constraint if exists "fk_legacy"');
    expect(up[0]).toContain('add constraint "comments_post_id_fkey"');
    expect(up[1]).toBe(VALIDATE);
    // Old key restored before the new one goes: no moment with neither.
    const down = statementsOf(migration.down);
    expect(down[0]).toContain('add constraint "fk_legacy"');
    expect(down.at(-1)).toBe(
      'alter table "comments" drop constraint if exists "comments_post_id_fkey"',
    );
  });

  test('a removed key with no replacement stays in the transaction', () => {
    const migration = generateMigration({
      entities: [bareComments, posts],
      current: snapshotOf([comments(), posts]),
      name: 'unlink',
      now: AT,
    });
    expect(migration.followUp).toBeUndefined();
    expect(migration.transactional).toBe(true);
    expect(statementsOf(migration.up)).toEqual([
      'alter table "comments" drop constraint "comments_post_id_fkey"',
    ]);
  });
});
