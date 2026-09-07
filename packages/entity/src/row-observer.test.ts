// What the observer reports, per write verb — and the two things it must never do: change what a
// write does, or turn a working write into a failing one.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import { createRecordingClient, setDbClient } from '@ultimat3/db';
import { integer, text, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { N_PLUS_ONE_THRESHOLD } from './n-plus-one';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import { observedRepo, type RowBulkChange, type RowChange, setRowObserver } from './row-observer';

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
  setDbClient(undefined);
  clearRegistry();
});

const idAt = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

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

// Measured on ai-maxxing, 2026-09-06: an `upsertAll` of five pull requests logged
// `X_N_PLUS_ONE_QUERY: pull_requests.findById ran 5 times in one request` — the observer's own
// `before` reads, one per row, tripping the detector the framework ships. The threshold is the
// detector's; a batch one past it is the smallest case the old shape could not pass.
describe('the before-read of a batch is one statement, never one per row', () => {
  const batch = Array.from({ length: N_PLUS_ONE_THRESHOLD + 1 }, (_, index) => ({
    id: idAt(100 + index),
    label: `tag ${index}`,
  }));

  test('an upsertAll reads its before-rows in ONE statement, and every row is still reported', async () => {
    const seen: RowChange[] = [];
    setRowObserver({ onChange: (change) => seen.push(change) });
    const recorded = createRecordingClient();
    setDbClient(recorded);
    // Two of the six are already stored, so the read has to answer per row, not just "some".
    const stored = batch.slice(0, 2).map((row) => ({ id: row.id, label: 'old' }));
    recorded.on('from "observed_tags"', { rows: stored });
    recorded.on('insert into "observed_tags"', { rows: batch });
    const repo = observedRepo(tags, postgresRepo(tags));

    const written = await repo.upsertAll(batch, { onConflict: ['id'], onMatch: 'update' });

    const reads = recorded.texts.filter((text) => text.startsWith('select'));
    expect(reads).toHaveLength(1);
    expect(reads.length).toBeLessThan(N_PLUS_ONE_THRESHOLD);
    // The set, as one `in` list — the statement `X_N_PLUS_ONE_QUERY`'s own fix line asks for.
    expect(reads[0]).toContain('"id" in (');
    // The ids, then the page bound (`limit + 1`, the row that says whether there is a next page).
    expect(recorded.statements[0]?.values.slice(0, batch.length)).toEqual(
      batch.map((row) => row.id),
    );
    expect(written).toHaveLength(batch.length);
    expect(seen.map((change) => change.op)).toEqual([
      'update',
      'update',
      'insert',
      'insert',
      'insert',
      'insert',
    ]);
    expect(seen[0]?.before).toMatchObject({ id: batch[0]?.id, label: 'old' });
    expect(seen[5]?.after).toMatchObject({ id: batch[5]?.id });
  });

  test('the memory driver answers the same six changes, so the two drivers agree', async () => {
    const seen: RowChange[] = [];
    setRowObserver({ onChange: (change) => seen.push(change) });
    const db = database({ tags }, { driver: memoryDriver() });
    await db.tags.insertAll(batch.slice(0, 2).map((row) => ({ ...row, label: 'old' })));
    seen.length = 0;

    await db.tags.upsertAll(batch, { onConflict: ['id'], onMatch: 'update' });

    expect(seen.map((change) => change.op)).toEqual([
      'update',
      'update',
      'insert',
      'insert',
      'insert',
      'insert',
    ]);
    expect(seen.map((change) => (change.after as { id: string }).id)).toEqual(
      batch.map((row) => row.id),
    );
  });

  test('a read that refuses leaves the write alone: every row reports as an insert', async () => {
    const seen: RowChange[] = [];
    setRowObserver({ onChange: (change) => seen.push(change) });
    const recorded = createRecordingClient();
    recorded.on('insert into "observed_tags"', { rows: batch });
    // Every read refuses; the write goes through. The rejection is the subject's input, never a
    // verdict — which is why it is a bare `Error` and not one of this package's own.
    setDbClient({
      ...recorded,
      query: <T>(fragment: { readonly text: string }): Promise<readonly T[]> =>
        fragment.text.startsWith('select')
          ? Promise.reject(new Error('the read is refused'))
          : recorded.query<T>(fragment as never),
    });
    const repo = observedRepo(tags, postgresRepo(tags));

    const written = await repo.upsertAll(batch, { onConflict: ['id'], onMatch: 'update' });

    expect(written).toHaveLength(batch.length);
    expect(new Set(seen.map((change) => change.op))).toEqual(new Set(['insert']));
  });
});
