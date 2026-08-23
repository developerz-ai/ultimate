// The one question this file answers: given a set of doomed tables, which `drop table` may run
// first. Postgres refuses a drop while anything still points at the table (`2BP01`), and the
// migration aborts mid-file with nothing recorded in the ledger and a `down` that cannot restore.

import { describe, expect, test } from 'bun:test';
import { dropOrder } from './drop-order';
import type { ForeignKeyDescription, TableDescription } from './introspect';

const key = (name: string, column: string, target: string): ForeignKeyDescription => ({
  name,
  columns: [column],
  referencedTable: target,
  referencedColumns: ['id'],
  onDelete: null,
});

const table = (
  name: string,
  foreignKeys: readonly ForeignKeyDescription[] = [],
): TableDescription => ({
  schema: 'public',
  name,
  columns: [],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys,
});

const names = (tables: readonly TableDescription[]): readonly string[] =>
  tables.map((entry) => entry.name);

describe('dropOrder', () => {
  test('a table nothing points at keeps its place', () => {
    const order = dropOrder([table('a'), table('b')]);
    expect(names(order.tables)).toEqual(['a', 'b']);
    expect(order.constraints).toEqual([]);
  });

  test('the child goes before the parent, against the alphabet the catalog hands us', () => {
    // `SchemaDescription` is sorted by name, so the parent arrives FIRST — which is the one
    // order Postgres refuses.
    const authors = table('authors');
    const posts = table('posts', [key('posts_author_id_fkey', 'author_id', 'authors')]);
    const order = dropOrder([authors, posts]);
    expect(names(order.tables)).toEqual(['posts', 'authors']);
    expect(order.constraints).toEqual([]);
  });

  test('a chain unwinds leaf-first, however deep', () => {
    const a = table('a');
    const b = table('b', [key('b_a_fkey', 'a_id', 'a')]);
    const c = table('c', [key('c_b_fkey', 'b_id', 'b')]);
    expect(names(dropOrder([a, b, c]).tables)).toEqual(['c', 'b', 'a']);
  });

  test('a self-reference is not a blocker and needs no constraint drop', () => {
    // `drop table` takes the table's OWN constraints with it.
    const nodes = table('nodes', [key('nodes_parent_id_fkey', 'parent_id', 'nodes')]);
    const order = dropOrder([nodes]);
    expect(names(order.tables)).toEqual(['nodes']);
    expect(order.constraints).toEqual([]);
  });

  test('a cycle has no safe order, so one inbound key is dropped first', () => {
    const left = table('left', [key('left_right_fkey', 'right_id', 'right')]);
    const right = table('right', [key('right_left_fkey', 'left_id', 'left')]);
    const order = dropOrder([left, right]);

    expect(order.constraints).toEqual(['alter table "right" drop constraint "right_left_fkey";']);
    expect(names(order.tables)).toEqual(['left', 'right']);
  });

  test('every doomed table is dropped exactly once', () => {
    const a = table('a', [key('a_b_fkey', 'b_id', 'b')]);
    const b = table('b', [key('b_c_fkey', 'c_id', 'c')]);
    const c = table('c', [key('c_a_fkey', 'a_id', 'a')]);
    const order = dropOrder([a, b, c]);

    expect([...names(order.tables)].sort()).toEqual(['a', 'b', 'c']);
    expect(order.constraints).toHaveLength(1);
  });

  test('nothing to drop is no statements at all', () => {
    expect(dropOrder([])).toEqual({ tables: [], constraints: [] });
  });
});
