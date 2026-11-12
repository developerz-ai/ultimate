// A repository read honours the scope's signal: an entity `findMany`, `findById` and `count`
// stuck behind a table lock is cancelled on the server when its caller hangs up, and the caller
// is thrown `X_ABORTED` at once. No entity code does this — the read goes out through `@ultimat3/db`'s
// pooled funnel (`statement-cancel.ts`), and this file pins that it still does. Skips unless
// `TEST_DATABASE_URL`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext } from '@ultimat3/core';
import {
  type DbConnection,
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

// Unconditional and top-level: a skipped suite still registered its entities on import.
afterAll(() => {
  clearRegistry();
});

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const notes = entity('pg_read_cancel_notes', {
  columns: { id: uuid().primaryKey(), body: text({ max: 40 }) },
});

const DROP = 'drop table if exists "pg_read_cancel_notes" cascade';
const NOTE = '00000000-0000-7000-8000-0000000000aa';

describe.skipIf(!hasPostgres)('live · postgres · an entity read cancelled on abort', () => {
  let client: PostgresClient;
  let holder: PostgresClient;

  beforeAll(async () => {
    // `max: 1`: the pool answering the next read proves the cancelled one gave its slot back.
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    holder = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    setDbClient(client);
    await holder.execute(raw(DROP));
    const migration = generateMigration({
      entities: [notes.$describe()],
      name: 'live read cancel',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await holder.execute(raw(statement));
  });

  afterAll(async () => {
    await holder.execute(raw(DROP));
    await client.close();
    await holder.close();
    setDbClient(undefined);
  });

  /** A transaction holding `access exclusive` on the table: every read of it waits. */
  const lockTable = async (): Promise<DbConnection> => {
    const pinned = await holder.reserve();
    await pinned.execute(sql`begin`);
    await pinned.execute(raw('lock table "pg_read_cancel_notes" in access exclusive mode'));
    return pinned;
  };

  /** Until the reader's backend is waiting on that lock: an abort before the send cancels nothing. */
  const waitingOnLock = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const row = await holder.one<{ waiting: number }>(
        sql`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and query like '%pg_read_cancel_notes%'`,
      );
      if ((row?.waiting ?? 0) > 0) return;
    }
    expect.unreachable('the entity read never reached the server');
  };

  // Typed as the one shape the loop runs, so each read is a thunk `runWithContext` takes alike.
  const reads: Readonly<Record<string, () => Promise<unknown>>> = {
    findMany: () => postgresRepo(notes).findMany({}),
    findById: () => postgresRepo(notes).findById(NOTE),
    count: () => postgresRepo(notes).count({}),
  };

  for (const [name, read] of Object.entries(reads)) {
    test(`${name}: abort behind a lock → X_ABORTED within 200 ms, the pool answering`, async () => {
      const pinned = await lockTable();
      try {
        const controller = new AbortController();
        const reading = runWithContext(ctxOf({ signal: controller.signal }), read);
        await waitingOnLock();
        const aborted = performance.now();
        controller.abort();
        const error = await reading.then(
          () => expect.unreachable(`${name} answered after its caller hung up`),
          (thrown: unknown) => thrown,
        );
        expect(performance.now() - aborted).toBeLessThan(200);
        expect(error).toMatchObject({ code: 'X_ABORTED' });
      } finally {
        await pinned.execute(sql`rollback`);
        pinned.release();
      }
      // The one pooled connection is free again: the cancelled read did not keep it.
      expect(await postgresRepo(notes).count({})).toBe(0);
    });
  }
});
