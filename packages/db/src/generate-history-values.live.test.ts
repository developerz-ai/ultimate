// The history trigger on a real Postgres over the values `to_jsonb` spells otherwise than the row:
// an `int8` past 2^53 and a `numeric` keep their digits as text, a `timestamptz` is UTC ISO under a
// non-UTC session zone — in the before image and the after image alike.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { generateMigration } from './generate';
import { raw } from './sql';
import { statementsOf } from './statement-split';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const LEDGER = 'hsv_ledger';
const HISTORY = `${LEDGER}_history`;
const ID = '00000000-0000-0000-0000-000000000001';

const col = (column: string, kind: string, notNull = true): ColumnDescriptionLike => ({
  property: column,
  column,
  kind,
  notNull,
  primaryKey: column === 'id',
  unique: false,
  hasDefault: false,
  check: null,
  references: null,
});

const entities: readonly EntityDescriptionLike[] = [
  {
    name: LEDGER,
    table: LEDGER,
    primaryKey: ['id'],
    columns: [
      col('id', 'uuid'),
      col('serial', 'bigint'),
      col('rate', 'numeric(8, 2)'),
      col('settled_at', 'timestamptz'),
    ],
    indexes: [],
    history: {
      table: HISTORY,
      key: 'id',
      tenant: null,
      ignore: [],
      text: ['serial', 'rate'],
      instants: ['settled_at'],
    },
  },
  {
    name: HISTORY,
    table: HISTORY,
    primaryKey: ['id'],
    columns: [
      col('id', 'uuid'),
      col('row_id', 'text'),
      col('op', 'text'),
      col('at', 'timestamptz'),
      col('actor_id', 'text', false),
      col('request_id', 'text', false),
      col('before', 'jsonb', false),
      col('after', 'jsonb', false),
    ],
    indexes: [],
  },
];

interface Image {
  readonly op: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

describe.skipIf(!hasPostgres)('live · postgres · the history trigger keeps exact values', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    for (const table of [HISTORY, LEDGER]) {
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    }
    const migration = generateMigration({
      entities,
      name: 'history values',
      now: new Date('2026-11-06T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    for (const table of [HISTORY, LEDGER]) {
      await client.execute(raw(`drop table if exists "${table}" cascade`));
    }
    await client.close();
  });

  test('digits and the UTC instant, before and after, whatever the session zone', async () => {
    await withTransaction(
      async (tx) => {
        await tx.execute(raw("set local time zone 'America/New_York'"));
        await tx.execute(
          raw(
            `insert into "${LEDGER}" values ('${ID}', 9007199254740993, 7.50, ` +
              "'2026-11-06T10:15:30.123Z')",
          ),
        );
        await tx.execute(raw(`update "${LEDGER}" set rate = 8.10 where id = '${ID}'`));
      },
      { client },
    );
    const rows = await client.query<Image>(
      raw(`select op, before, after from "${HISTORY}" order by op`),
    );
    const image = {
      serial: '9007199254740993',
      rate: '7.50',
      settled_at: '2026-11-06T10:15:30.123Z',
    };
    expect(rows.map((row) => row.op)).toEqual(['insert', 'update']);
    expect(rows[0]?.after).toMatchObject(image);
    expect(rows[1]?.before).toMatchObject(image);
    expect(rows[1]?.after).toMatchObject({ ...image, rate: '8.10' });
  });
});
