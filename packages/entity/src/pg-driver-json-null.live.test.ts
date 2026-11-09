// The JSON value `null` in a `jsonb` column against a real server through Bun's `sql`: a NOT NULL
// column whose schema admits `null` stores `'null'::jsonb` and reads it back; a nullable column's
// `null` stays SQL NULL. `json-null-parity.test.ts` holds memory to PGlite; this is the production
// client. Skips unless `TEST_DATABASE_URL` is set, as the live suite does.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { json } from './columns-data';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const shape = t.object({ a: t.number });

const events = entity('json_null_live_events', {
  columns: {
    id: uuid().primaryKey(),
    code: text({ max: 10 }).unique(),
    payload: json(t.nullable(shape)),
    note: json(shape).nullable(),
  },
});

const DROP = 'drop table if exists "json_null_live_events" cascade';
const ID = '00000000-0000-7000-8000-000000000001';

describe.skipIf(!hasPostgres)('live · postgres · the JSON null in a jsonb column', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [events.$describe()],
      name: 'live json null',
      now: new Date('2026-11-08T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  beforeEach(async () => {
    await client.execute(raw('delete from "json_null_live_events"'));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const db = () => database({ events }, { driver: postgresDriver() });

  /** What the table holds per row, by `code`: SQL NULL is `null`, else the jsonb type. */
  const stored = async (column: 'payload' | 'note'): Promise<readonly (string | null)[]> => {
    const rows = await client.query<{ kind: string | null }>(
      raw(`select jsonb_typeof("${column}") as kind from "json_null_live_events" order by code`),
    );
    return rows.map((row) => row.kind);
  };

  test('insert and update store the JSON literal in a NOT NULL column, and read it back', async () => {
    await db().events.insert({ id: ID, code: 'a', payload: null });
    expect(await db().events.where({ id: ID }).one()).toEqual({
      id: ID,
      code: 'a',
      payload: null,
      note: null,
    });
    await db().events.update(ID, { payload: { a: 1 } });
    await db().events.update(ID, { payload: null });
    expect((await db().events.where({ id: ID }).one())?.payload).toBeNull();
    expect(await stored('payload')).toEqual(['null']);
  });

  test('insertAll and upsertAll bind the same literal', async () => {
    await db().events.insertAll([{ code: 'a', payload: null }]);
    await db().events.upsertAll([{ code: 'b', payload: null }], { onConflict: ['code'] });
    await db().events.upsertAll([{ code: 'a', payload: null }], { onConflict: ['code'] });
    expect(await stored('payload')).toEqual(['null', 'null']);
    expect((await db().events.all()).map((row) => row.payload)).toEqual([null, null]);
  });

  test('a null test sees no SQL NULL in the NOT NULL column; containment sees the literal', async () => {
    await db().events.insert({ id: ID, code: 'a', payload: null });
    expect(await db().events.andWhere('payload', 'is-null', null).count()).toBe(0);
    expect(await db().events.andWhere('payload', 'contains', null).count()).toBe(1);
  });

  test("a nullable column's null is SQL NULL, explicit or absent", async () => {
    await db().events.insert({ id: ID, code: 'a', payload: { a: 1 }, note: { a: 2 } });
    await db().events.update(ID, { note: null });
    await db().events.insert({ code: 'b', payload: { a: 1 } });
    expect(await stored('note')).toEqual([null, null]);
    expect(await db().events.andWhere('note', 'is-null', null).count()).toBe(2);
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
