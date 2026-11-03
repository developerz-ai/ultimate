// `postgresDriver()` on a real Postgres: an autocommit write past a coded abort sends nothing, a
// client hang-up lands, and a straggler through a finished transaction's handle is refused. The
// embedded and memory suite is `write-abandon.test.ts`. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, UltimateError } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import {
  generateMigration,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
  withTransaction,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const ID = '00000000-0000-7000-8000-000000000001';

afterAll(() => {
  clearRegistry();
});

const abortedWith = (reason: unknown): AbortSignal => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

describe.skipIf(!hasPostgres)('live · postgres · a repository write past the abort', () => {
  const notes = entity('wa_live_notes', {
    columns: { id: uuid().primaryKey(), title: text({ max: 40 }) },
  });
  let client: PostgresClient;
  const handle = () => database({ notes }, { driver: postgresDriver() });

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', role: 'web', profile: { max: 2 } });
    setDbClient(client);
    await client.execute(raw('drop table if exists wa_live_notes'));
    const migration = generateMigration({
      entities: [notes.$describe()],
      name: 'write abandon live',
      now: new Date('2026-11-02T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  beforeEach(async () => {
    await client.execute(raw('delete from wa_live_notes'));
  });

  afterAll(async () => {
    await client.execute(raw('drop table if exists wa_live_notes'));
    setDbClient(undefined);
    await client.close();
  });

  test('an autocommit insert after a coded abort rejects with the reason, 0 rows', async () => {
    const reason = new UltimateError({
      code: 'X_TIMEOUT',
      cause: 'past the deadline',
      fix: 'raise it',
    });
    const db = handle();
    const outcome = await runWithContext(ctxOf({ signal: abortedWith(reason) }), () =>
      db.notes.insert({ id: ID, title: 'late' }).catch((error: unknown) => error),
    );
    expect(outcome).toBe(reason);
    expect(await db.notes.where({ id: ID }).one()).toBeNull();
  });

  test('a client hang-up lands', async () => {
    const hangUp = new DOMException('The operation was aborted.', 'AbortError');
    const db = handle();
    await runWithContext(ctxOf({ signal: abortedWith(hangUp) }), () =>
      db.notes.insert({ id: ID, title: 'kept' }),
    );
    expect((await db.notes.where({ id: ID }).one())?.title).toBe('kept');
  });

  test('a repository straggler past the rollback is X_DB_TRANSACTION_CLOSED, 0 rows', async () => {
    const db = handle();
    const ended = Promise.withResolvers<void>();
    let late: Promise<unknown> = Promise.resolve();
    await withTransaction(() => {
      late = ended.promise.then(() => db.notes.insert({ id: ID, title: 'straggler' }));
      late.catch(() => undefined);
      return Promise.reject(new RangeError('the sibling failed'));
    }).catch(() => undefined);
    ended.resolve();
    const error = (await late.catch((thrown: unknown) => thrown)) as { code?: string };
    expect(error.code).toBe('X_DB_TRANSACTION_CLOSED');
    expect(await db.notes.where({ id: ID }).one()).toBeNull();
  });
});
