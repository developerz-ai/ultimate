// What the observer reports, per write verb — and the two things it must never do: change what a
// write does, or turn a working write into a failing one.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { integer, text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { type RowBulkChange, type RowChange, setRowObserver } from './row-observer';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ONE = '00000000-0000-4000-8000-000000000001';
const TWO = '00000000-0000-4000-8000-000000000002';

const notes = entity('observed_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 40 }),
    reads: integer().default(0),
  },
});

/** No tenant column: `onConflict: ['id']` is a legal updating target only on such an entity. */
const tags = entity('observed_tags', {
  columns: { id: uuid().primaryKey(), label: text({ max: 40 }) },
});

/** A composite key, so `findById` cannot name a row — the case `readsById` answers `null` for. */
const reads = entity('observed_reads', {
  columns: { id: uuid(), memberId: uuid(), label: text({ max: 40 }) },
  primaryKey: ['id', 'memberId'],
});

const build = (): {
  db: ReturnType<typeof database<{ notes: typeof notes }>>;
  seen: RowChange[];
} => {
  const seen: RowChange[] = [];
  setRowObserver({
    onChange: (change) => {
      seen.push(change);
    },
  });
  return { db: database({ notes }, { driver: memoryDriver() }), seen };
};

const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: 'm1', orgId: ORG, roles: [] }) }), work);

afterEach(() => {
  setRowObserver(null);
  clearRegistry();
});

describe('every write verb reports what it committed', () => {
  test('insert reports the stored row, with no before', async () => {
    const { db, seen } = build();
    await asMember(() => db.notes.insert({ id: ONE, orgId: ORG, title: 'one' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.op).toBe('insert');
    expect(seen[0]?.before).toBeNull();
    expect(seen[0]?.after).toMatchObject({ id: ONE, title: 'one' });
    expect(seen[0]?.entity).toBe('observed_notes');
  });

  test('insertAll reports one change per row', async () => {
    const { db, seen } = build();
    await asMember(() =>
      db.notes.insertAll([
        { id: ONE, orgId: ORG, title: 'one' },
        { id: TWO, orgId: ORG, title: 'two' },
      ]),
    );
    expect(seen.map((change) => change.op)).toEqual(['insert', 'insert']);
  });

  // Both halves, because a consumer diffs them: a patch built from `after` alone carries every
  // column, and one built from a wrong `before` carries the wrong ones.
  test('update reports the row on both sides of the write', async () => {
    const { db, seen } = build();
    await asMember(async () => {
      await db.notes.insert({ id: ONE, orgId: ORG, title: 'one' });
      await db.notes.update(ONE, { title: 'renamed' });
    });
    const change = seen[1];
    expect(change?.op).toBe('update');
    expect(change?.before).toMatchObject({ title: 'one' });
    expect(change?.after).toMatchObject({ title: 'renamed' });
  });

  test('delete reports the row that went, and no after', async () => {
    const { db, seen } = build();
    await asMember(async () => {
      await db.notes.insert({ id: ONE, orgId: ORG, title: 'one' });
      await db.notes.delete(ONE);
    });
    expect(seen[1]?.op).toBe('delete');
    expect(seen[1]?.before).toMatchObject({ id: ONE });
    expect(seen[1]?.after).toBeNull();
  });

  // A collision is what separates an insert from an update, and nothing in the result says which
  // happened — so the `before` read per row is what decides it.
  test('upsertAll separates the rows it created from the rows it changed', async () => {
    const seen: RowChange[] = [];
    setRowObserver({ onChange: (change) => seen.push(change) });
    // `tags`, not `notes`: an updating upsert whose conflict target omits the tenant column is
    // refused (`X_TENANCY_UNSCOPED`), and `id` alone is the only unique key declared here.
    const db = database({ tags }, { driver: memoryDriver() });
    await db.tags.insert({ id: ONE, label: 'one' });
    await db.tags.upsertAll(
      [
        { id: ONE, label: 'changed' },
        { id: TWO, label: 'new' },
      ],
      { onConflict: ['id'], onMatch: 'update' },
    );
    expect(seen.map((change) => change.op)).toEqual(['insert', 'update', 'insert']);
  });
});

describe('a filtered write is reported as bulk, never as silence', () => {
  test('updateWhere and deleteWhere report a count, and no row change', async () => {
    const bulk: RowBulkChange[] = [];
    const seen: RowChange[] = [];
    setRowObserver({
      onChange: (change) => {
        seen.push(change);
      },
      onBulk: (change) => {
        bulk.push(change);
      },
    });
    const db = database({ notes }, { driver: memoryDriver() });
    await asMember(async () => {
      await db.notes.insertAll([
        { id: ONE, orgId: ORG, title: 'one' },
        { id: TWO, orgId: ORG, title: 'two' },
      ]);
      await db.notes.updateWhere({ orgId: ORG }, { title: 'swept' });
      await db.notes.deleteWhere({ orgId: ORG });
    });
    expect(bulk).toEqual([
      { entity: 'observed_notes', op: 'update', rows: 2 },
      { entity: 'observed_notes', op: 'delete', rows: 2 },
    ]);
    // The itemised stream carries the two inserts and nothing the filter touched — a consumer that
    // read only `onChange` would believe the sweep never happened, which is why `onBulk` exists.
    expect(seen.map((change) => change.op)).toEqual(['insert', 'insert']);
  });

  test('a write that matched nothing reports nothing', async () => {
    const bulk: RowBulkChange[] = [];
    setRowObserver({ onChange: () => undefined, onBulk: (change) => bulk.push(change) });
    const db = database({ notes }, { driver: memoryDriver() });
    await asMember(() => db.notes.deleteWhere({ orgId: ORG }));
    expect(bulk).toEqual([]);
  });
});

describe('the observer never changes what a write does', () => {
  test('with none installed, the write path is untouched', async () => {
    setRowObserver(null);
    const db = database({ notes }, { driver: memoryDriver() });
    const row = await asMember(() => db.notes.insert({ id: ONE, orgId: ORG, title: 'one' }));
    expect(row).toMatchObject({ id: ONE, title: 'one', reads: 0 });
  });

  /**
   * `findById` is the right lookup exactly when the primary key IS `id`. On a composite key it
   * cannot name a row at all, so reporting `before: null` is the honest answer — the alternative is
   * a confident read of whichever row happens to carry that `id`, which on this entity is not the
   * row the write touched. `null` is also what logical replication reports without
   * `REPLICA IDENTITY FULL`, so a consumer already handles it.
   */
  test('a composite key reports no before rather than the wrong row', async () => {
    const seen: RowChange[] = [];
    setRowObserver({ onChange: (change) => seen.push(change) });
    const db = database({ reads }, { driver: memoryDriver() });
    await db.reads.insert({ id: ONE, memberId: TWO, label: 'first' });
    await db.reads.updateWhere({ id: ONE, memberId: TWO }, { label: 'second' });
    // The insert is itemised; the filtered update is the composite key's only update path and is
    // reported as bulk — neither of them invents a `before` it cannot read.
    expect(seen.map((change) => change.op)).toEqual(['insert']);
    expect(seen[0]?.before).toBeNull();
  });

  // One process runs every test file, so an inner harness that cleared unconditionally would take
  // an outer one's observer with it.
  test('setRowObserver hands back what it replaced', () => {
    const first = { onChange: () => undefined };
    const second = { onChange: () => undefined };
    expect(setRowObserver(first)).toBeNull();
    expect(setRowObserver(second)).toBe(first);
    expect(setRowObserver(null)).toBe(second);
  });
});
