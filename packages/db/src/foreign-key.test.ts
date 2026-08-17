// The identity two subsystems share. `x db gen` decides "does the database already hold this key"
// and `checkDrift` decides "does the database still hold it" off the same string, so a difference
// here is a migration that adds a constraint that exists or a drift report on a correct database.

import { describe, expect, test } from 'bun:test';
import { addForeignKey, dropForeignKey, foreignKeyTarget } from './foreign-key';
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
});
