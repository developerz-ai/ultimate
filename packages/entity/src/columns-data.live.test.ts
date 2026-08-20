// The column vocabulary against a real server, which is the only thing that can answer it. Every
// type here was chosen from what a driver actually hands back and actually accepts — `int8` as a
// string, `numeric` as a string, a `date` as midnight UTC, an array as a literal — and each of
// those is a claim only Postgres can settle. `columns-data.test.ts` pins the parsing; this pins
// the round trip. Skips unless `TEST_DATABASE_URL` is set, as the live suite does.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import type { PlainDate } from '@ultimat3/time';
import { plainDate } from '@ultimat3/time';
import { text, uuid } from './columns';
import { arrayOf, bigint, bytes, date, decimal, json } from './columns-data';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const payload = t.object({ plan: t.string, seats: t.number });

const records = entity('wide_live_records', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    /** `numeric(18,8)`: the treasury case — a rate no JS number holds exactly. */
    rate: decimal({ precision: 18, scale: 8 }),
    /** The date a rate takes effect. A date, not an instant: it has no time to be wrong about. */
    effectiveOn: date(),
    /** An `int8` past 2^53 — the value a `number` would round and a `bigint` would fail to JSON. */
    externalId: bigint(),
    settings: json(payload),
    tags: arrayOf(text({ max: 20 })),
    blob: bytes().nullable(),
  },
});

const DROP = 'drop table if exists "wide_live_records" cascade';

describe.skipIf(!hasPostgres)('live · postgres · the wide column vocabulary', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [records.$describe()],
      name: 'live wide columns',
      now: new Date('2026-08-18T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
    clearRegistry();
  });

  const db = () => database({ records }, { driver: postgresDriver() });

  test('the generated DDL carries the precise Postgres type of every column', async () => {
    const columns = await client.query<{ column_name: string; data_type: string }>(
      raw(
        `select column_name, format_type(a.atttypid, a.atttypmod) as data_type
           from information_schema.columns c
           join pg_attribute a on a.attrelid = 'wide_live_records'::regclass
            and a.attname = c.column_name
          where c.table_name = 'wide_live_records'`,
      ),
    );
    const byName = new Map(columns.map((row) => [row.column_name, row.data_type]));
    expect(byName.get('rate')).toBe('numeric(18,8)');
    expect(byName.get('effective_on')).toBe('date');
    expect(byName.get('external_id')).toBe('bigint');
    expect(byName.get('settings')).toBe('jsonb');
    expect(byName.get('tags')).toBe('text[]');
    expect(byName.get('blob')).toBe('bytea');
  });

  test('every value survives the round trip as the type the row declared', async () => {
    const written = await db().records.insert({
      label: 'treasury',
      rate: '1.23456789',
      effectiveOn: '2026-03-14' as PlainDate,
      externalId: '9007199254740993',
      settings: { plan: 'team', seats: 12 },
      tags: ['alpha', 'with,comma', 'quote"inside'],
      blob: new Uint8Array([0, 255, 16]),
    });
    const stored = await db().records.where({ id: written.id }).one();
    expect(stored).not.toBeNull();
    // The decimal keeps every digit AND the trailing zeroes the column's scale defines.
    expect(stored?.rate).toBe('1.23456789');
    // The date is a date: no time, no zone, and the same string the row was written with.
    expect(stored?.effectiveOn).toBe(plainDate('2026-03-14'));
    // Past 2^53, exactly — a `number` here would read back 9007199254740992.
    expect(stored?.externalId).toBe('9007199254740993');
    expect(stored?.settings).toEqual({ plan: 'team', seats: 12 });
    // The literal encoder's whole job: a comma and a quote inside an element are still one element.
    expect(stored?.tags).toEqual(['alpha', 'with,comma', 'quote"inside']);
    expect([...(stored?.blob ?? [])]).toEqual([0, 255, 16]);
    // Both drivers hand bytes back differently; the row holds the plain form either way.
    expect(Object.getPrototypeOf(stored?.blob)).toBe(Uint8Array.prototype);
  });

  test('the whole row is JSON, which a bigint or a Buffer would not have been', async () => {
    const [row] = (await db().records.where({ label: 'treasury' }).all()) as readonly {
      rate: string;
      externalId: string;
      effectiveOn: string;
    }[];
    const json = JSON.parse(JSON.stringify({ ...row, blob: null })) as Record<string, unknown>;
    expect(json['rate']).toBe('1.23456789');
    expect(json['externalId']).toBe('9007199254740993');
    expect(json['effectiveOn']).toBe('2026-03-14');
  });

  test('an empty array and a null blob are stored and read as themselves', async () => {
    const written = await db().records.insert({
      label: 'empty',
      rate: '0.00000001',
      effectiveOn: '2026-01-01' as PlainDate,
      externalId: '0',
      settings: { plan: 'free', seats: 1 },
      tags: [],
      blob: null,
    });
    const stored = await db().records.where({ id: written.id }).one();
    expect(stored?.tags).toEqual([]);
    expect(stored?.blob).toBeNull();
  });

  test('the server refuses what the column refuses — a scale the type cannot hold', async () => {
    // The column rejects it first, which is the point: the same rule, one layer earlier.
    await expect(
      db().records.insert({
        label: 'too precise',
        rate: '1.234567891',
        effectiveOn: '2026-01-01' as PlainDate,
        externalId: '1',
        settings: { plan: 'free', seats: 1 },
        tags: [],
      }),
    ).rejects.toThrow(/decimal places/);
  });
});
