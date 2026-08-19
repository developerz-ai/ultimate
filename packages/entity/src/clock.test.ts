// Every instant the entity layer WRITES comes from `ctx.clock`. The read path reads no clock at
// all — that is what makes it drivable — while the write path read `systemClock` at five sites, so
// a frozen clock drove nothing: `createdAt`, `updatedAt` and `deletedAt` were the wall clock
// however the ctx was built, and a test could only ever assert a range.

import { afterAll, describe, expect, test } from 'bun:test';
import { createContext, frozenClock, runWithContext, userActor } from '@ultimat3/core';
import { createRecordingClient, setDbClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

const notes = entity('clock_test_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    body: text({ max: 40 }),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

const ORG = '00000000-0000-7000-8000-0000000000a1';
const FROZEN = new Date('2031-04-05T06:07:08.000Z');

const db = () => database({ notes }, { driver: memoryDriver() });

/** A request whose clock is stopped — the shape a deterministic test is written in. */
const atFrozen = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(
    createContext({ actor: userActor({ id: 'writer', orgId: ORG }), clock: frozenClock(FROZEN) }),
    work,
  );

afterAll(() => {
  clearRegistry();
});

describe('the write path reads ctx.clock', () => {
  test('defaultNow() stamps the frozen instant, not the wall clock', async () => {
    const row = await atFrozen(() => db().notes.insert({ orgId: ORG, body: 'first' }));

    expect(row.createdAt).toEqual(FROZEN);
  });

  test('onUpdateNow() stamps it too, on the update that writes it', async () => {
    const table = db().notes;
    const written = await atFrozen(async () => {
      const row = await table.insert({ orgId: ORG, body: 'first' });
      return table.update(row.id, { body: 'second' });
    });

    expect(written.updatedAt).toEqual(FROZEN);
  });

  // `includeDeleted` is the repository's argument and no chain method, so the stamp is read back
  // where it is written: through `memoryRepo`, which is what `database()` hands the table anyway.
  test('the soft-delete stamp is the same instant', async () => {
    const repo = memoryRepo(notes);
    const hidden = await atFrozen(async () => {
      const row = await repo.insert(notes.$parse({ orgId: ORG, body: 'first' }));
      await repo.delete(row.id);
      const page = await repo.findMany({ includeDeleted: true });
      return page.rows[0];
    });

    expect(hidden?.deletedAt).toEqual(FROZEN);
    // And the row it stamped is the row the default clock would have written a different one on.
    expect(hidden?.createdAt).toEqual(FROZEN);
  });

  // The Postgres driver stamps the same column from the same call, so the two drivers cannot
  // disagree about when a row was deleted — `pg-driver.ts` had its own `systemClock` read.
  test('the Postgres driver binds that instant into the soft-delete statement', async () => {
    const client = createRecordingClient();
    setDbClient(client);
    try {
      await atFrozen(() => postgresRepo(notes).deleteWhere({ body: 'first' }));
      // First bind of `set "deleted_at" = $1`, before the filter's own values.
      expect(client.statements.at(-1)?.values[0]).toEqual(FROZEN);
    } finally {
      setDbClient(undefined);
    }
  });

  // Outside a request there is no ctx to read one from, and the system clock IS the answer —
  // a script, a worker boot and a seed all take that branch, exactly as they did before.
  test('outside a request the system clock still answers', async () => {
    const before = Date.now();
    const row = await db().notes.insert({ orgId: ORG, body: 'ambient' });

    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.createdAt).not.toEqual(FROZEN);
  });
});
