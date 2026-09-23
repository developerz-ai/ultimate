// Single responsibility: `min`/`max` over a `timestamptz` answer the same instant in both drivers,
// whatever the SESSION time zone prints. The statement cast the aggregate to bare `::text` and
// `new Date` parsed that: an offset with seconds (`+00:19:32`, Amsterdam's pre-1937 LMT) was NaN,
// and year `0099` came back as 1999.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createPgliteClient,
  generateMigration,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { timestamp, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const PGLITE_BOOT_MS = 30_000;

const events = entity('atp_events', {
  columns: { id: uuid().primaryKey(), at: timestamp() },
});

const client = createPgliteClient();

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [events.$describe()],
    name: 'aggregate time parity',
    now: new Date('2026-09-23T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

beforeEach(async () => {
  await client.execute(raw('delete from "atp_events"'));
  await client.execute(raw("set time zone 'UTC'"));
});

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
  clearRegistry();
});

const AT = [
  new Date('0099-06-01T00:00:00.000Z'),
  new Date('1900-01-01T12:00:00.000Z'),
  new Date('2026-09-23T10:15:30.123Z'),
];

const seed = async (driver: Driver): Promise<void> => {
  const db = database({ events }, { driver });
  for (const [position, at] of AT.entries()) {
    await db.events.insert({ id: `00000000-0000-7000-8000-00000000000${position + 1}`, at });
  }
};

const extremes = async (driver: Driver): Promise<readonly unknown[]> => {
  const db = database({ events }, { driver });
  return [await db.events.min('at'), await db.events.max('at')];
};

describe('min/max over a timestamptz', () => {
  // Rows are WRITTEN under a UTC session and the session zone is changed only for the aggregate:
  // this pins the aggregate path alone. (Reading a whole row back under a non-UTC session is a
  // separate decode path, and not this row's.)
  test.each(['UTC', 'Europe/Amsterdam', 'America/New_York', 'Asia/Tokyo'])(
    'the same instants under a %s session',
    async (zone) => {
      const memory = memoryDriver();
      await seed(memory);
      await seed(postgresDriver());
      await client.execute(raw(`set time zone '${zone}'`));
      const fromMemory = await extremes(memory);
      const fromPg = await extremes(postgresDriver());
      expect(fromMemory).toEqual([AT[0], AT[2]]);
      expect(fromPg).toEqual(fromMemory);
    },
    PGLITE_BOOT_MS,
  );
});
