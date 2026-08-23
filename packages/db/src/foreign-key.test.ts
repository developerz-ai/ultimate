// The identity two subsystems share. `x db gen` decides "does the database already hold this key"
// and `checkDrift` decides "does the database still hold it" off the same string, so a difference
// here is a migration that adds a constraint that exists or a drift report on a correct database.

import { describe, expect, test } from 'bun:test';
import { addForeignKey, dropForeignKey, foreignKeyTarget, onDeleteRule } from './foreign-key';
import type { ForeignKeyDescription } from './introspect';

const key = (overrides: Partial<ForeignKeyDescription> = {}): ForeignKeyDescription => ({
  name: 'posts_org_id_fkey',
  columns: ['org_id'],
  referencedTable: 'orgs',
  referencedColumns: ['id'],
  onDelete: null,
  ...overrides,
});

describe('unit · foreignKeyTarget', () => {
  test('the name is not part of it — a hand-written constraint is the same key', () => {
    expect(foreignKeyTarget(key({ name: 'fk_posts_org' }))).toBe(foreignKeyTarget(key()));
  });

  test('`onDelete` is not part of it — no generated clause has ever declared one', () => {
    expect(foreignKeyTarget(key({ onDelete: 'c' }))).toBe(foreignKeyTarget(key()));
  });

  test('a composite key is an ordered pairing, so swapping either list is a different key', () => {
    const composite = key({ columns: ['a', 'b'], referencedColumns: ['x', 'y'] });
    const swappedSource = key({ columns: ['b', 'a'], referencedColumns: ['x', 'y'] });
    const swappedTarget = key({ columns: ['a', 'b'], referencedColumns: ['y', 'x'] });
    expect(foreignKeyTarget(swappedSource)).not.toBe(foreignKeyTarget(composite));
    expect(foreignKeyTarget(swappedTarget)).not.toBe(foreignKeyTarget(composite));
  });

  test('where it points is part of it', () => {
    expect(foreignKeyTarget(key({ referencedTable: 'tenants' }))).not.toBe(foreignKeyTarget(key()));
  });
});

describe('unit · the two statements', () => {
  test('add names every column of a composite key, in order, on both sides', () => {
    expect(
      addForeignKey('lines', key({ columns: ['a', 'b'], referencedColumns: ['x', 'y'] })),
    ).toBe(
      'alter table "lines" add constraint "posts_org_id_fkey" foreign key ("a", "b") ' +
        'references "orgs" ("x", "y");',
    );
  });

  test('drop names the constraint, which is why add writes the name out rather than guessing it', () => {
    expect(dropForeignKey('posts', 'posts_org_id_fkey')).toBe(
      'alter table "posts" drop constraint "posts_org_id_fkey";',
    );
  });

  test('add writes the on delete rule out, so a declared cascade reaches the database', () => {
    // `entity()` has carried `{ onDelete: 'cascade' }` since 1.0 and no clause ever spelled one:
    // the rule type-checked, generated `references "orgs" ("id");`, and deleting an org left
    // every child row behind on a constraint that refuses the delete instead.
    expect(addForeignKey('posts', key({ onDelete: 'cascade' }))).toBe(
      'alter table "posts" add constraint "posts_org_id_fkey" foreign key ("org_id") ' +
        'references "orgs" ("id") on delete cascade;',
    );
  });

  test('a rule the catalog spells as a character is written out in full', () => {
    expect(addForeignKey('posts', key({ onDelete: 'n' }))).toContain('on delete set null');
  });

  test('no action is no clause, whichever way it arrives', () => {
    expect(addForeignKey('posts', key({ onDelete: 'a' }))).not.toContain('on delete');
    expect(addForeignKey('posts', key({ onDelete: 'no action' }))).not.toContain('on delete');
  });

  test('a rule Postgres does not have is X_INVARIANT, never spliced into the DDL', () => {
    // The only way in is a hand-built description: `entity()`'s option is a closed union.
    expect(() => addForeignKey('posts', key({ onDelete: 'drop table posts' }))).toThrow(
      /X_INVARIANT/,
    );
  });
});

describe('unit · onDeleteRule', () => {
  test('the catalog character and the declared name are one vocabulary', () => {
    expect([
      onDeleteRule('c'),
      onDeleteRule('r'),
      onDeleteRule('n'),
      onDeleteRule('d'),
      onDeleteRule('cascade'),
    ]).toEqual(['cascade', 'restrict', 'set null', 'set default', 'cascade']);
  });

  test('`a` and `no action` are both "nothing was declared"', () => {
    // Postgres records the default on every key, so reading it as a rule would report a
    // difference on every constraint a snapshot never spelled one for.
    expect([onDeleteRule('a'), onDeleteRule('no action'), onDeleteRule(null)]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test('it is idempotent, so either side may be normalised twice', () => {
    expect(onDeleteRule(onDeleteRule('c'))).toBe('cascade');
  });

  test('a prototype member is a name, never the member', () => {
    // `CATALOG_RULES[raw]` walked the prototype, so `onDeleteRule('constructor')` handed back the
    // `Object` FUNCTION through a `string | null` signature — `compareForeignKeys` then compared a
    // function against a string and reported a `changed-foreign-key` whose fix: was DDL built out
    // of it. An unknown rule is normalised and handed back, prototype name or not.
    for (const raw of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(onDeleteRule(raw)).toBe(raw.toLowerCase());
    }
  });
});
