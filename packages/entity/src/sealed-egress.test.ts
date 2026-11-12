// One assertion per way a row leaves this package toward a caller. Every higher tier serialises a
// row through one of these — an `output` parse (`$schema`), a view, the record envelope and the
// browser store (`rowsOf` / `recordProjection`), a change feed (the row observer, `decodeRow`) —
// so a sealed column absent from each of them is absent from HTTP, the typed client, MCP and a
// persisted record without any of those packages knowing what sealed means. A history image is
// one more: the memory driver's `imageOf` and the Postgres trigger's `to_jsonb`, PGlite-migrated.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { EntityRowEvent } from '@ultimat3/core';
import { isSealed, subscribe } from '@ultimat3/core';
import { generateMigration, pgliteClient, raw, setDbClient, statementsOf } from '@ultimat3/db';
import { t } from '@ultimat3/schema';
import { text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { history } from './history-read';
import { postgresDriver } from './pg-driver';
import { decodeRow } from './pg-row';
import { recordProjection } from './record-projection';
import { clearRegistry } from './registry';
import { rowsOf } from './rows-of';

const accounts = entity('se_accounts', {
  persist: true,
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    secret: text().sealed(),
    email: text().sealed({ lookup: true }),
  },
});

const ID = '0198c1a0-0000-7000-8000-000000000001';
/** The row a handler holds: the whole row, plaintext included. */
const row = { id: ID, name: 'Ada', secret: 'hunter2', email: 'ada@example.com' };

afterAll(() => {
  clearRegistry();
});

const parsed = (schema: unknown, value: unknown): unknown => {
  const result = (
    schema as { '~standard': { validate(value: unknown): { value?: unknown; issues?: unknown } } }
  )['~standard'].validate(value);
  if (result.issues !== undefined) return expect.unreachable('the schema refused its own row');
  return result.value;
};

describe('unit · a sealed column leaves the server through no path', () => {
  test('an output parsed through $schema answers without it — bare and wrapped', () => {
    expect(parsed(accounts.$schema, row)).toEqual({ id: ID, name: 'Ada' });
    expect(parsed(t.array(accounts.$schema), [row])).toEqual([{ id: ID, name: 'Ada' }]);
    expect(parsed(t.object({ account: accounts.$schema.nullable() }), { account: row })).toEqual({
      account: { id: ID, name: 'Ada' },
    });
    // The published shape — OpenAPI, the typed client, an MCP tool's schema — has no such field.
    expect(Object.keys(accounts.$schema.node.properties ?? {})).toEqual(['id', 'name']);
    // …and the schema does not REQUIRE what it will not return: a wire row parses back.
    expect(parsed(accounts.$schema, { id: ID, name: 'Ada' })).toEqual({ id: ID, name: 'Ada' });
  });

  test('$parse is still the whole row: server code validates what it writes', () => {
    expect(accounts.$parse(row)).toEqual(row);
  });

  test('the record envelope omits it, whatever object the handler returned', () => {
    const records = rowsOf(t.array(accounts.$schema), [row]);
    expect(records['se_accounts']?.[ID]).toEqual({ id: ID, name: 'Ada' });
    expect(JSON.stringify(records)).not.toMatch(/hunter2|ada@example\.com/);
    // The handler's own row is untouched: the record is a copy.
    expect(row.secret).toBe('hunter2');
  });

  test('a persist: true record — what the browser store writes to disk — omits it', () => {
    const projection = recordProjection(accounts);
    expect(projection.persist).toBe(true);
    expect(projection.sealed).toEqual(['secret', 'email']);
    // The store keeps `projection.schema` beside the rows: it describes no sealed column either.
    expect(Object.keys(projection.schema.properties ?? {})).toEqual(['id', 'name']);
  });

  test('a committed change reported to a live query omits it, before and after', async () => {
    const changes: EntityRowEvent[] = [];
    const off = subscribe('entity.row', (event) => void changes.push(event.payload));
    try {
      const table = database({ accounts }, { driver: memoryDriver() }).accounts;
      const made = await table.insert({ name: 'Ada', secret: 'hunter2', email: 'ada@example.com' });
      await table.update(made.id, { secret: 'rotated' });
      await table.delete(made.id);
    } finally {
      off();
    }
    expect(changes.map((change) => change.op)).toEqual(['insert', 'update', 'delete']);
    expect(JSON.stringify(changes)).not.toMatch(/hunter2|rotated|ada@example\.com/);
    for (const change of changes) {
      for (const side of [change.before, change.after]) {
        if (side !== null) expect(Object.keys(side).sort()).toEqual(['id', 'name']);
      }
    }
  });

  test('a row decoded off the write-ahead log holds the stored string, never the plaintext', async () => {
    const table = database({ accounts }, { driver: memoryDriver() }).accounts;
    await table.insert({ name: 'Ada', secret: 'hunter2', email: 'ada@example.com' });
    // What logical replication hands a change feed: the physical row, exactly as stored.
    const stored = {
      id: ID,
      name: 'Ada',
      secret: 'x1.0123456789abcdef.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA',
      email: null,
    };
    const decoded = decodeRow(accounts, { ...stored, email: stored.secret });
    expect(isSealed(decoded.secret)).toBe(true);
    expect(isSealed(decoded.email)).toBe(true);
  });

  test('a view cannot name it at all', () => {
    expect(() => accounts.$view(['id', 'secret'])).toThrow(/X_ENTITY_SEALED_IN_VIEW/);
  });
});

const people = entity('se_people', {
  columns: {
    id: uuid().primaryKey(),
    name: text(),
    ssn: text().sealed({ lookup: true }),
    note: text().sealed(),
  },
  history: true,
});
const peopleHistory = people.$history ?? expect.unreachable('history: true declares one');
const PEOPLE = { people, peopleHistory };
const client = pgliteClient();
const PGLITE_BOOT_MS = 30_000;

beforeAll(async () => {
  setDbClient(client);
  const migration = generateMigration({
    entities: [people.$describe(), peopleHistory.$describe()],
    name: 'sealed history',
    now: new Date('2026-11-11T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

const HISTORY_DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', memoryDriver],
  ['postgres (PGlite)', () => postgresDriver()],
];

describe.each(HISTORY_DRIVERS)('unit · history images · %s', (_name, makeDriver) => {
  test('a history image carries no sealed column', async () => {
    const db = database(PEOPLE, { driver: makeDriver() });
    const ada = await db.people.insert({ name: 'Ada', ssn: '078-05-1120', note: 'hunter2' });
    const bob = await db.people.insert({ name: 'Bob', ssn: '078-05-1120', note: 'hunter2' });
    await db.people.update(ada.id, { name: 'Ada L.', note: 'rotated' });
    // A change to a sealed column alone records nothing: its image is the one before it.
    await db.people.update(bob.id, { note: 'rotated' });
    await db.people.delete(ada.id);
    const versions = [
      ...(await history(db.peopleHistory, ada.id)),
      ...(await history(db.peopleHistory, bob.id)),
    ];
    expect(versions.map((version) => version.op)).toEqual(['insert', 'update', 'delete', 'insert']);
    for (const version of versions) {
      for (const image of [version.before, version.after]) {
        if (image !== null) expect(Object.keys(image).sort()).toEqual(['id', 'name']);
      }
    }
    // Neither the plaintext nor the stored string: a lookup column's ciphertext is deterministic,
    // so two rows sharing one would be an equality oracle in the history table.
    expect(JSON.stringify(versions)).not.toMatch(/078-05-1120|hunter2|rotated|x1\./);
  });
});
