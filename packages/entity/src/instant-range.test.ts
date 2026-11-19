// A `timestamp()` value outside years 0001–9999, written through each door a row has: memory
// stored it and Postgres refused the statement. Both refuse now, with one code, before a statement.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  generateMigration,
  type PgliteClient,
  pgliteClient,
  raw,
  statementsOf,
} from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
import { arrayOf } from './columns-data';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const marks = entity('instant_range_marks', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 20 }),
    at: timestamp(),
    seen: arrayOf(timestamp()).nullable(),
  },
});

const ID = '00000000-0000-7000-8000-000000000001';
const OTHER = '00000000-0000-7000-8000-000000000002';
const FIRST = new Date('0001-01-01T00:00:00.000Z');
const LAST = new Date('9999-12-31T23:59:59.999Z');
const OUTSIDE = [
  new Date(FIRST.getTime() - 1),
  new Date(LAST.getTime() + 1),
  new Date(-8.64e15),
  new Date(8.64e15),
];

let pglite: PgliteClient;
const drivers: (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['postgres (PGlite)', () => postgresDriver({ client: pglite })],
];

beforeAll(async () => {
  pglite = pgliteClient();
  const { up } = generateMigration({
    entities: [marks.$describe()],
    name: 'instant range',
    now: new Date('2026-11-19T00:00:00.000Z'),
  });
  for (const statement of statementsOf(up)) await pglite.execute(raw(statement));
}, 30_000);

afterAll(async () => {
  await pglite.close();
  clearRegistry();
});

const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code;

describe.each(drivers)('%s · an instant outside years 0001–9999', (_name, driverOf) => {
  const db = () => database({ marks }, { driver: driverOf() });

  test('the first and last instants are stored and read back', async () => {
    const table = db().marks;
    await table.insert({ id: ID, label: 'first', at: FIRST, seen: [FIRST, LAST] });
    await table.update(ID, { at: LAST });
    expect(await table.where({ id: ID }).one()).toMatchObject({ at: LAST, seen: [FIRST, LAST] });
  });

  test.each(OUTSIDE)('%p is refused by insert, insertAll, update and updateWhere', async (at) => {
    const table = db().marks;
    const row = { id: OTHER, label: 'out', at };
    expect(await table.insert(row).catch(codeOf)).toBe('X_INVARIANT_VIOLATED');
    expect(await table.insertAll([row]).catch(codeOf)).toBe('X_INVARIANT_VIOLATED');
    expect(await table.update(ID, { at }).catch(codeOf)).toBe('X_INVARIANT_VIOLATED');
    expect(await table.updateWhere({ id: ID }, { at }).catch(codeOf)).toBe('X_INVARIANT_VIOLATED');
    expect(
      await table.insert({ id: OTHER, label: 'out', at: FIRST, seen: [at] }).catch(codeOf),
    ).toBe('X_INVARIANT_VIOLATED');
    expect(await table.where({ id: OTHER }).one()).toBeNull();
  });
});

test('a row the server already holds past year 9999 still reads', async () => {
  await pglite.execute(
    raw(
      `insert into instant_range_marks (id, label, at) values ('00000000-0000-7000-8000-000000000009', 'sentinel', '12000-01-01T00:00:00Z')`,
    ),
  );
  const table = database({ marks }, { driver: postgresDriver({ client: pglite }) }).marks;
  const row = await table.where({ id: '00000000-0000-7000-8000-000000000009' }).one();
  expect(row?.at.getUTCFullYear()).toBe(12_000);
});
