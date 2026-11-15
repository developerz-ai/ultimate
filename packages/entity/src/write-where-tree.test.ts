// A chain's filtered write over a predicate TREE bounds exactly what its read would — never more. An
// empty `and` holds for every row, and so does an `or` with such an arm: neither may be the only
// thing standing between `deleteAll()` and the tenant's whole table. And an `undefined` value is a
// bug at its line wherever it sits in a group, as it is at the top.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';

const notes = entity('write_where_tree_notes', {
  columns: { id: uuid().primaryKey(), postId: uuid(), kind: text({ max: 10 }) },
});

afterAll(() => {
  clearRegistry();
});

const POST = '00000000-0000-7000-8000-0000000000b1';
const OTHER = '00000000-0000-7000-8000-0000000000b2';

const seeded = async () => {
  const db = database({ notes }, { driver: memoryDriver() });
  await db.notes.insert({ id: '00000000-0000-7000-8000-0000000000c1', postId: POST, kind: 'a' });
  await db.notes.insert({ id: '00000000-0000-7000-8000-0000000000c2', postId: OTHER, kind: 'b' });
  return db;
};

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : `uncoded: ${String(error)}`;
  }
};

describe('a filtered write over a tree refuses one that bounds nothing', () => {
  for (const [name, node] of [
    ['an empty and', { and: [] }],
    ['an or with an empty-and arm', { or: [{ and: [] }] }],
    ['an and of empty groups', { and: [{ and: [] }, { or: [{ and: [] }] }] }],
  ] as const) {
    test(`${name}: deleteAll and updateAll are X_WRITE_UNFILTERED, and nothing moves`, async () => {
      const db = await seeded();
      expect(await codeOf(() => db.notes.andWhereNode(node).deleteAll())).toBe(
        'X_WRITE_UNFILTERED',
      );
      expect(await codeOf(() => db.notes.andWhereNode(node).updateAll({ kind: 'z' }))).toBe(
        'X_WRITE_UNFILTERED',
      );
      expect((await db.notes.limit(10).all()).map((row) => row.kind).sort()).toEqual(['a', 'b']);
    });
  }

  test('an empty or bounds the write to no row — it is allowed, and deletes nothing', async () => {
    const db = await seeded();
    expect(await db.notes.andWhereNode({ or: [] }).deleteAll()).toBe(0);
    expect(await db.notes.limit(10).all()).toHaveLength(2);
  });

  test('a real group still writes exactly its rows', async () => {
    const db = await seeded();
    const node = { or: [{ column: 'postId', op: 'eq', value: POST }] } as const;
    expect(await db.notes.andWhereNode(node).deleteAll()).toBe(1);
  });
});

describe('an undefined value inside a group is refused, as at the top', () => {
  test('and: [postId neq undefined] does not update every row', async () => {
    const db = await seeded();
    const node = { and: [{ column: 'postId', op: 'neq', value: undefined }] } as const;
    expect(await codeOf(() => db.notes.andWhereNode(node).updateAll({ kind: 'z' }))).toBe(
      'X_WRITE_UNFILTERED',
    );
    const nested = { or: [{ and: [{ column: 'kind', op: 'eq', value: undefined }] }] } as const;
    expect(await codeOf(() => db.notes.andWhereNode(nested).deleteAll())).toBe(
      'X_WRITE_UNFILTERED',
    );
    expect((await db.notes.limit(10).all()).map((row) => row.kind).sort()).toEqual(['a', 'b']);
  });
});
