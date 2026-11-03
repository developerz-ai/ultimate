// An autocommit repository write past a coded abort is refused on BOTH drivers: `writing()` is the
// Postgres funnel, and the memory driver asks the same question at each write. A client hang-up is
// not a refusal, and `runToCompletion` is the way through.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runToCompletion, runWithContext, UltimateError } from '@ultimat3/core';
import {
  completeTransaction,
  generateMigration,
  pgliteClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;
const ID = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';

const notes = entity('wa_notes', {
  columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
});
const ENTITIES = { notes };
const client = pgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [notes.$describe()],
    name: 'write abandon',
    now: new Date('2026-11-02T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from wa_notes'));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const timedOut = (): UltimateError =>
  new UltimateError({ code: 'X_TIMEOUT', cause: 'past the deadline', fix: 'raise it' });

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

const DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['postgres (embedded)', () => postgresDriver()],
];

for (const [name, build] of DRIVERS) {
  describe(`a write past the abort — ${name}`, () => {
    const handle = () => database(ENTITIES, { driver: build() });

    test('every autocommit write rejects with the signal reason, the same object', async () => {
      const db = handle();
      await db.notes.insert({ id: OTHER, title: 'there' });
      const reason = timedOut();
      const writes: readonly (() => Promise<unknown>)[] = [
        () => db.notes.insert({ id: ID, title: 'late' }),
        () => db.notes.insertAll([{ id: ID, title: 'late' }]),
        () => db.notes.upsertAll([{ id: ID, title: 'late' }], { onConflict: ['id'] }),
        () => db.notes.update(OTHER, { title: 'late' }),
        () => db.notes.delete(OTHER),
        () => db.notes.deleteWhere({ id: OTHER }),
        () => db.notes.updateWhere({ id: OTHER }, { title: 'late' }),
      ];
      await runWithContext(ctxOf({ signal: abortedWith(reason) }), async () => {
        for (const write of writes) {
          // Rejects: a repository call never throws synchronously.
          const sent = write();
          expect(await sent.catch((thrown: unknown) => thrown)).toBe(reason);
        }
      });
      expect(await db.notes.where({ id: ID }).one()).toBeNull();
      expect((await db.notes.where({ id: OTHER }).one())?.title).toBe('there');
    });

    test('a read is not a write: it still answers', async () => {
      const db = handle();
      await db.notes.insert({ id: ID, title: 'there' });
      const row = await runWithContext(ctxOf({ signal: abortedWith(timedOut()) }), () =>
        db.notes.where({ id: ID }).one(),
      );
      expect(row?.title).toBe('there');
    });

    test('a client hang-up keeps landing', async () => {
      const db = handle();
      const hangUp = new DOMException('The operation was aborted.', 'AbortError');
      await runWithContext(ctxOf({ signal: abortedWith(hangUp) }), () =>
        db.notes.insert({ id: ID, title: 'kept' }),
      );
      expect((await db.notes.where({ id: ID }).one())?.title).toBe('kept');
    });

    test('runToCompletion lands it', async () => {
      const db = handle();
      await runWithContext(ctxOf({ signal: abortedWith(timedOut()) }), () =>
        runToCompletion(() => db.notes.insert({ id: ID, title: 'owed' })),
      );
      expect((await db.notes.where({ id: ID }).one())?.title).toBe('owed');
    });

    test('inside a root marked by completeTransaction a write is not refused', async () => {
      const db = handle();
      const controller = new AbortController();
      await runWithContext(ctxOf({ signal: controller.signal }), () =>
        withTransaction(
          async () => {
            completeTransaction();
            controller.abort(timedOut());
            await db.notes.insert({ id: ID, title: 'rides the commit' });
          },
          { client },
        ),
      );
      expect((await db.notes.where({ id: ID }).one())?.title).toBe('rides the commit');
    });
  });
}
