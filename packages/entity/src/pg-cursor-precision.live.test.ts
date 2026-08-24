// Keyset pagination across rows a JS `Date` cannot tell apart. A `timestamptz` holds microseconds
// and a cursor used to carry milliseconds, so the seek and the `order by` ranked rows differently
// and a `desc` page dropped every row inside the boundary millisecond. Only a real server can show
// it: `memoryRepo` stores millisecond `Date`s, and asserting statement text cannot say which rows
// come back.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { timestamp, uuid } from './columns';
import { entity } from './entity';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';
import type { Page } from './repo';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const events = entity('pg_precision_events', {
  columns: { id: uuid().primaryKey(), createdAt: timestamp().defaultNow() },
});

type Event = typeof events.$row;

const DROP = 'drop table if exists "pg_precision_events" cascade';

/**
 * Three rows inside ONE millisecond, and the ids are adversarial on purpose: under `desc` the row
 * a page ends on holds the LARGEST id of its millisecond, which is what a uuid v7 key gives you
 * for free — so the `id > …` tiebreak the old seek fell back to could never match the two rows the
 * `created_at < …` term had already excluded.
 */
const SEEDED: readonly (readonly [string, string])[] = [
  ['00000000-0000-7000-8000-000000000003', '2026-01-01T00:00:00.123900Z'],
  ['00000000-0000-7000-8000-000000000001', '2026-01-01T00:00:00.123500Z'],
  ['00000000-0000-7000-8000-000000000002', '2026-01-01T00:00:00.123100Z'],
];

/** Ordered `createdAt desc`: the microsecond field is the only thing separating the three. */
const DESCENDING = ['…0003', '…0001', '…0002'];

const shortId = (row: Event): string => `…${String(row.id).slice(-4)}`;

describe.skipIf(!hasPostgres)('live · postgres · cursor precision', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [events.$describe()],
      name: 'live cursor precision',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    // Written as SQL, not through the repository: `bindValues` binds a JS `Date`, so the driver
    // itself cannot produce a row whose timestamp has microseconds. `default now()` can, which is
    // what every `timestamp().defaultNow()` column gets, and so can any other writer of the table.
    for (const [id, at] of SEEDED) {
      await client.execute(
        raw(`insert into "pg_precision_events" ("id", "created_at") values ('${id}', '${at}')`),
      );
    }
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  /** Every row the walk hands back, one page at a time, from the top. */
  const walk = async (direction: 'asc' | 'desc', limit: number): Promise<string[]> => {
    const repo = postgresRepo(events);
    const seen: string[] = [];
    let cursor: string | null = null;
    // Bounded: a seek that stops advancing has to fail the test, never hang the run.
    for (let page = 0; page < 8; page += 1) {
      const result: Page<Event> = await repo.findMany({
        orderBy: [{ column: 'createdAt', direction }],
        limit,
        cursor,
      });
      seen.push(...result.rows.map(shortId));
      if (result.nextCursor === null) return seen;
      cursor = result.nextCursor;
    }
    expect.unreachable('the walk never reached a null cursor');
  };

  test('a desc page one row at a time visits every row inside one millisecond', async () => {
    expect(await walk('desc', 1)).toEqual(DESCENDING);
  });

  test('an asc page one row at a time visits every row inside one millisecond', async () => {
    expect(await walk('asc', 1)).toEqual([...DESCENDING].reverse());
  });

  test('a page boundary inside the millisecond never repeats a row', async () => {
    expect(await walk('desc', 2)).toEqual(DESCENDING);
  });
});
