// `updateMany` against a real Postgres: the server accepts the `update … from (select … union all
// …)` shape for every kind of column the entity writes, a different value lands on each row, the
// tenant scope and the soft-delete filter hold, and 1,000 rows are one statement. Skips unless
// `TEST_DATABASE_URL` is set, as the live suite does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ctxOf, runWithContext, subscribe, userActor } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import { json } from './columns-data';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { updateManyStatements } from './pg-update-many-sql';
import { clearRegistry } from './registry';
import type { UpdateManyRow } from './repo';
import { updateManyPlan } from './update-many';
import { sendUpdateMany } from './update-many-send';

// Unconditional and top-level: a skipped suite still registered its entities on import.
afterAll(() => {
  clearRegistry();
});

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const items = entity('um_live_items', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    excerpt: text().nullable(),
    rank: integer().default(0),
    done: boolean().default(false),
    meta: json(t.object({ a: t.number })).nullable(),
    price: money().nullable(),
    seenAt: timestamp().nullable(),
    deletedAt: timestamp().nullable(),
  },
});

type Item = typeof items.$row;

const DROP = 'drop table if exists "um_live_items" cascade';
const ORG = '00000000-0000-7000-8000-000000000a01';
const OTHER = '00000000-0000-7000-8000-000000000a02';
const idAt = (index: number): string =>
  `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;

const inOrg = <T>(org: string, work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1', orgId: org }) }), work);

describe.skipIf(!hasPostgres)('live · postgres · updateMany', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [items.$describe()],
      name: 'live update many',
      now: new Date('2026-11-11T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const repo = () => postgresRepo(items);

  const seed = (org: string, from: number, count: number): Promise<readonly Item[]> =>
    inOrg(org, () =>
      repo().insertAll(
        Array.from({ length: count }, (_, at) => ({
          id: idAt(from + at),
          orgId: org,
          excerpt: null,
          rank: 0,
          done: false,
          meta: null,
          price: null,
          seenAt: null,
          deletedAt: null,
        })),
      ),
    );

  /** The rows updated, through the three E2 pieces exactly as the driver strings them together. */
  const updateMany = (org: string, rows: readonly UpdateManyRow<Item>[]) =>
    inOrg(org, async () => {
      const plan = updateManyPlan(items, rows, undefined);
      return sendUpdateMany(
        items,
        updateManyStatements(items, plan, false),
        false,
        client,
        undefined,
      );
    });

  const statementsDuring = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    let seen = 0;
    const off = subscribe('db.statement', ({ payload }) => {
      if (payload.text.includes('"um_live_items"')) seen += 1;
    });
    try {
      return [await work(), seen];
    } finally {
      off();
    }
  };

  test('every column kind takes a different value per row, typed by the table', async () => {
    await seed(ORG, 1, 2);
    const at = new Date('2026-11-11T08:00:00.123Z');
    const { count } = await updateMany(ORG, [
      {
        id: idAt(1),
        patch: {
          excerpt: 'one',
          rank: 11,
          done: true,
          meta: { a: 1 },
          price: { minor: 1999, currency: 'EUR' },
          seenAt: at,
        },
      },
      {
        id: idAt(2).toUpperCase(),
        patch: { excerpt: null, rank: 22, done: false, meta: null, price: null, seenAt: null },
      },
    ]);
    expect(count).toBe(2);
    const [one, two] = await inOrg(ORG, async () => [
      await repo().findById(idAt(1)),
      await repo().findById(idAt(2)),
    ]);
    expect(one).toMatchObject({ excerpt: 'one', rank: 11, done: true, meta: { a: 1 }, seenAt: at });
    expect(one?.price).toMatchObject({ minor: 1999, currency: 'EUR' });
    expect(two).toMatchObject({ excerpt: null, rank: 22, done: false, meta: null, price: null });
    const [typed] = await client.query<{ kind: string }>(
      sql`select jsonb_typeof(meta) as kind from um_live_items where id = ${idAt(1)}`,
    );
    expect(typed?.kind).toBe('object');
  });

  test("another tenant's row and a soft-deleted row are not written, and not counted", async () => {
    await seed(ORG, 10, 2);
    await seed(OTHER, 20, 1);
    await inOrg(ORG, () => repo().delete(idAt(11)));
    const { count } = await updateMany(ORG, [
      { id: idAt(10), patch: { rank: 1 } },
      { id: idAt(11), patch: { rank: 1 } },
      { id: idAt(20), patch: { rank: 1 } },
      { id: idAt(99), patch: { rank: 1 } },
    ]);
    expect(count).toBe(1);
    const [theirs] = await client.query<{ rank: number }>(
      sql`select rank from um_live_items where id = ${idAt(20)}`,
    );
    expect(theirs?.rank).toBe(0);
    const [deleted] = await client.query<{ rank: number }>(
      sql`select rank from um_live_items where id = ${idAt(11)}`,
    );
    expect(deleted?.rank).toBe(0);
  });

  test('1,000 rows, a different value each, is one statement', async () => {
    await seed(ORG, 1000, 1000);
    const rows = Array.from({ length: 1000 }, (_, at) => ({
      id: idAt(1000 + at),
      patch: { excerpt: `excerpt ${at}`, rank: at },
    }));
    const [result, statements] = await statementsDuring(() => updateMany(ORG, rows));
    expect(result.count).toBe(1000);
    expect(statements).toBe(1);
    const [check] = await client.query<{ wrong: string }>(
      sql`select count(*)::text as wrong from um_live_items where id >= ${idAt(1000)} and id < ${idAt(2000)} and excerpt <> 'excerpt ' || rank`,
    );
    expect(check?.wrong).toBe('0');
  });
});
