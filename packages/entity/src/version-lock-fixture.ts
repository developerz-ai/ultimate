// Single responsibility: the declared optimistic lock's behaviour on a driver, written once and run
// by the memory unit file and the real-server live file, so the two cannot prove different rules.
// A test double, not public API: not exported from `index.ts`, and excluded from the package.

import { expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { integer, text, uuid } from './columns';
import type { Database } from './database';
import { entity } from './entity';

/** The lock's column, `.default(0)` and NOT NULL as `versionColumnOf` requires. */
export const lockedNotes = entity('version_lock_notes', {
  columns: {
    id: uuid().primaryKey(),
    body: text({ max: 40 }),
    lockVersion: integer().default(0),
  },
  version: 'lockVersion',
});

export type LockedDb = Database<{ readonly notes: typeof lockedNotes }>;

const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const codeOf = async (pending: Promise<unknown>): Promise<string> => {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return 'resolved';
  return isUltimateError(error) ? error.code : 'not an UltimateError';
};

/** Every case, registered on the calling file's `describe`. `base` keeps ids apart per driver. */
export const versionLockCases = (db: () => LockedDb, base: number): void => {
  const seed = async (n: number, body = 'first'): Promise<string> => {
    const id = idAt(base + n);
    await db().notes.insert({ id, body });
    return id;
  };
  const stored = async (id: string) => db().notes.where({ id }).one();

  test('an insert starts at the default; an update at that version stores one past it', async () => {
    const id = await seed(1);
    expect((await stored(id))?.lockVersion).toBe(0);
    const written = await db().notes.update(id, { body: 'second', lockVersion: 0 });
    expect(written.lockVersion).toBe(1);
    expect(await stored(id)).toMatchObject({ body: 'second', lockVersion: 1 });
  });

  test('an update at a version the row has left is X_ENTITY_STALE, and writes nothing', async () => {
    const id = await seed(2);
    await db().notes.update(id, { body: 'theirs', lockVersion: 0 });
    expect(await codeOf(db().notes.update(id, { body: 'mine', lockVersion: 0 }))).toBe(
      'X_ENTITY_STALE',
    );
    expect(await stored(id)).toMatchObject({ body: 'theirs', lockVersion: 1 });
  });

  test('an update naming no version is X_ENTITY_VERSION_INVALID; an absent row X_NOT_FOUND', async () => {
    const id = await seed(3);
    expect(await codeOf(db().notes.update(id, { body: 'blind' }))).toBe('X_ENTITY_VERSION_INVALID');
    expect(await codeOf(db().notes.update(idAt(base + 99), { body: 'x', lockVersion: 0 }))).toBe(
      'X_NOT_FOUND',
    );
    expect((await stored(id))?.body).toBe('first');
  });

  test('a filtered write increments every matched row, and may not set the version', async () => {
    const a = await seed(4, 'bulk');
    const b = await seed(5, 'bulk');
    await db().notes.update(b, { body: 'bulk', lockVersion: 0 });
    expect(await db().notes.where({ body: 'bulk' }).updateAll({ body: 'swept' })).toBe(2);
    expect((await stored(a))?.lockVersion).toBe(1);
    expect((await stored(b))?.lockVersion).toBe(2);
    expect(await codeOf(db().notes.where({ id: a }).updateAll({ lockVersion: 9 }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
    // The compare-and-set of a filtered write is spelled in the filter: stale matches nothing.
    expect(await db().notes.where({ id: a, lockVersion: 0 }).updateAll({ body: 'late' })).toBe(0);
    expect(await db().notes.where({ id: a, lockVersion: 1 }).updateAll({ body: 'on time' })).toBe(
      1,
    );
  });

  test('updateMany: each row at its version; one stale row refuses the batch whole', async () => {
    const a = await seed(6);
    const b = await seed(7);
    const written = await db().notes.updateMany([
      { id: a, patch: { body: 'a1', lockVersion: 0 } },
      { id: b, patch: { body: 'b1', lockVersion: 0 } },
    ]);
    expect(written).toBe(2);
    const batch = db().notes.updateMany([
      { id: a, patch: { body: 'a2', lockVersion: 1 } },
      { id: b, patch: { body: 'b2', lockVersion: 0 } },
    ]);
    expect(await codeOf(batch)).toBe('X_ENTITY_STALE');
    expect(await stored(a)).toMatchObject({ body: 'a1', lockVersion: 1 });
    expect(await stored(b)).toMatchObject({ body: 'b1', lockVersion: 1 });
    // An absent row is not counted, as without a lock — absence is not staleness.
    const gone = idAt(base + 98);
    expect(
      await db().notes.updateMany([
        { id: a, patch: { body: 'a3', lockVersion: 1 } },
        { id: gone, patch: { body: 'x', lockVersion: 0 } },
      ]),
    ).toBe(1);
    expect(await codeOf(db().notes.updateMany([{ id: a, patch: { body: 'no version' } }]))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
  });

  test("upsertAll overwriting stored rows is refused; onMatch: 'nothing' inserts", async () => {
    const id = await seed(8);
    const rows = [{ id, body: 'over' }];
    expect(await codeOf(db().notes.upsertAll(rows, { onConflict: ['id'] }))).toBe(
      'X_ENTITY_VERSION_INVALID',
    );
    const fresh = idAt(base + 9);
    const kept = await db().notes.upsertAll(
      [
        { id, body: 'over' },
        { id: fresh, body: 'new' },
      ],
      { onConflict: ['id'], onMatch: 'nothing' },
    );
    expect(kept.map((row) => row.id)).toEqual([fresh]);
    expect(await stored(id)).toMatchObject({ body: 'first', lockVersion: 0 });
  });

  test('two writers racing from one read: exactly one lands, the other is stale', async () => {
    const id = await seed(10);
    const outcomes = await Promise.all(
      ['left', 'right'].map((body) => codeOf(db().notes.update(id, { body, lockVersion: 0 }))),
    );
    expect([...outcomes].sort()).toEqual(['X_ENTITY_STALE', 'resolved']);
    expect((await stored(id))?.lockVersion).toBe(1);
  });
};
