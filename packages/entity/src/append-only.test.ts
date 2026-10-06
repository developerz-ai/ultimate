// `entity({ appendOnly: true })`: the declaration, the projection `x db gen` reads, and the
// repository refusing every write that would change or remove a stored row — on each of the write
// paths a `Repo` exposes, through `database()` and straight off the driver (which `defineSeed` uses).

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { APPEND_ONLY_CODE } from './append-only-errors';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const events = entity('ao_events', {
  columns: {
    id: uuid().primaryKey(),
    kind: text({ max: 40 }),
    note: text({ max: 40 }).nullable(),
  },
  indexes: [{ on: ['kind'], unique: true }],
  appendOnly: true,
});

const drafts = entity('ao_drafts', {
  columns: { id: uuid().primaryKey(), body: text({ max: 40 }) },
});

const ID = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';

/** The code a call rejected with, or `'resolved'`. */
const refusedWith = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : `not coded: ${String(error)}`;
  }
};

const message = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work();
  } catch (error) {
    if (isUltimateError(error)) return `${error.cause} | ${error.fix}`;
  }
  return expect.unreachable('the append-only write resolved');
};

describe('appendOnly · the declaration', () => {
  test('it is on the entity and on the projection, and absent means mutable', () => {
    expect(events.$appendOnly).toBe(true);
    expect(events.$describe().appendOnly).toBe(true);
    expect(drafts.$appendOnly).toBe(false);
    // Absent, never `false`: the schema hash is canonical JSON over this, and an app that never
    // says `appendOnly` must hash exactly what it hashed before the option existed.
    expect(Object.hasOwn(drafts.$describe(), 'appendOnly')).toBe(false);
  });

  test('a soft-delete column is refused: deleting it would be an UPDATE the table refuses', () => {
    expect(() =>
      entity('ao_soft', {
        columns: { id: uuid().primaryKey(), deletedAt: timestamp().nullable() },
        appendOnly: true,
      }),
    ).toThrow(/X_INVARIANT_VIOLATED[\s\S]*deletedAt[\s\S]*soft delete[\s\S]*appendOnly/);
  });

  test('an onUpdateNow() column is refused: nothing will ever stamp it', () => {
    expect(() =>
      entity('ao_stamped', {
        columns: { id: uuid().primaryKey(), updatedAt: timestamp().defaultNow().onUpdateNow() },
        appendOnly: true,
      }),
    ).toThrow(/X_INVARIANT_VIOLATED[\s\S]*updatedAt[\s\S]*onUpdateNow/);
  });

  test('a state machine is refused: a transition is an UPDATE', () => {
    expect(() =>
      entity('ao_machine', {
        columns: {
          id: uuid().primaryKey(),
          status: enumerated(['open', 'closed'] as const)
            .transitions({ open: ['closed'], closed: [] })
            .default('open'),
        },
        appendOnly: true,
      }),
    ).toThrow(/X_INVARIANT_VIOLATED[\s\S]*status[\s\S]*transitions/);
  });
});

describe('appendOnly · every write path a repository exposes', () => {
  const driver = memoryDriver();
  const db = database({ events, drafts }, { driver });

  test('appending is allowed: insert, insertAll, and an upsert that skips a collision', async () => {
    driver.reset?.();
    await db.events.insert({ id: ID, kind: 'opened' });
    await db.events.insertAll([{ id: OTHER, kind: 'closed' }]);
    const skipped = await db.events.upsertAll([{ id: ID, kind: 'opened', note: 'ignored' }], {
      onConflict: ['id'],
      onMatch: 'nothing',
    });
    expect(skipped).toEqual([]);
    expect(await db.events.count()).toBe(2);
  });

  const refusals: readonly (readonly [string, () => Promise<unknown>])[] = [
    ['update(id, patch)', () => db.events.update(ID, { note: 'edited' })],
    ['delete(id)', () => db.events.delete(ID)],
    ['updateWhere(filter, patch)', () => db.events.updateWhere({ kind: 'opened' }, { note: 'x' })],
    ['deleteWhere(filter)', () => db.events.deleteWhere({ kind: 'opened' })],
    [
      "upsertAll(…, { onMatch: 'update' })",
      () =>
        db.events.upsertAll([{ id: ID, kind: 'opened', note: 'x' }], {
          onConflict: ['id'],
          onMatch: 'update',
        }),
    ],
    [
      'upsertAll(…) — the default onMatch is update',
      () => db.events.upsertAll([{ id: ID, kind: 'opened' }], { onConflict: ['id'] }),
    ],
    ['the driver repo, as a seed reaches it', () => driver.repo(events).delete(ID)],
  ];

  for (const [name, work] of refusals) {
    test(`${name} is refused with the append-only code, and no row moved`, async () => {
      driver.reset?.();
      await db.events.insert({ id: ID, kind: 'opened' });
      expect(await refusedWith(work)).toBe(APPEND_ONLY_CODE);
      // The code is shared until it is registered, so the refusal is pinned by its words too.
      expect(await message(work)).toContain('is declared appendOnly: true');
      expect(await db.events.where({ id: ID }).one()).toEqual({
        id: ID,
        kind: 'opened',
        note: null,
      });
    });
  }

  test('a refusal rejects — it never throws synchronously', () => {
    let returned: unknown;
    expect(() => {
      returned = db.events.delete(ID);
    }).not.toThrow();
    expect(returned).toBeInstanceOf(Promise);
    return (returned as Promise<unknown>).catch(() => undefined);
  });

  test('the refusal names the entity, the call and the append in its place', async () => {
    const text = await message(() => db.events.update(ID, { note: 'edited' }));
    expect(text).toContain('ao_events.update()');
    expect(text).toContain('appendOnly');
    expect(text).toContain('insert');
    const upsert = await message(() =>
      db.events.upsertAll([{ id: ID, kind: 'opened' }], { onConflict: ['id'] }),
    );
    expect(upsert).toContain("onMatch: 'nothing'");
  });

  test('an entity that is not append-only is untouched', async () => {
    driver.reset?.();
    await db.drafts.insert({ id: ID, body: 'one' });
    await db.drafts.update(ID, { body: 'two' });
    await db.drafts.delete(ID);
    expect(await db.drafts.count()).toBe(0);
  });
});
