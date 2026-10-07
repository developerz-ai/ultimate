// A sealed column against a REAL Postgres: what the server stores, what its own `=` and its own
// UNIQUE answer over ciphertext, and what a NULL test sees. `sealed-column.test.ts` runs the same
// rules on memory and PGlite; this is the file that says a production server agrees.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateMasterKey, isSealed, isUltimateError } from '@ultimat3/core';
import {
  generateMigration,
  type PostgresClient,
  postgresClient,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const KEY_ENV = 'ULTIMATE_SECRETS_KEY';
const RING_ENV = 'ULTIMATE_SECRETS_RETIRED_KEYS';

const vault = entity('pg_sealed_vault', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    password: text({ max: 12 }).sealed(),
    token: text().nullable().sealed(),
    email: text().sealed({ lookup: true }).unique(),
  },
});

const DROP = 'drop table if exists "pg_sealed_vault" cascade';

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not an UltimateError';
  }
  return 'resolved';
};

afterAll(() => {
  clearRegistry();
});

describe.skipIf(!hasPostgres)('live · postgres · a sealed column', () => {
  let client: PostgresClient;
  const previousKey = process.env[KEY_ENV];
  const previousRing = process.env[RING_ENV];
  const firstKey = generateMasterKey();
  const table = () => database({ vault }, { driver: postgresDriver() }).vault;

  beforeAll(async () => {
    process.env[KEY_ENV] = firstKey;
    delete process.env[RING_ENV];
    client = postgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [vault.$describe()],
      name: 'live sealed',
      now: new Date('2026-10-01T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
    // Plain `text`, and no length CHECK on the sealed column: the stored string outgrows any bound.
    expect(migration.up).toMatch(/"password" text not null/);
    expect(migration.up).not.toContain('char_length(password)');
  });

  afterAll(async () => {
    if (previousKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = previousKey;
    if (previousRing === undefined) delete process.env[RING_ENV];
    else process.env[RING_ENV] = previousRing;
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  test('a row Postgres answers is server-only: named, never enumerated — whole, projected, written back', async () => {
    const made = await table().insert({
      label: 'shape',
      password: 'hunter2',
      token: null,
      email: 'shape@example.com',
    });
    const read = await table().where({ id: made.id }).one();
    const picked = await table().where({ id: made.id }).select({ id: true, password: true }).one();
    for (const row of [made, read, picked]) {
      expect(row?.password).toBe('hunter2');
      expect(JSON.stringify(row)).not.toMatch(/hunter2|shape@example\.com|x1\./);
      expect(Object.keys(row ?? {})).not.toContain('password');
    }
    // A spread insert of the required secret is refused by name; the row passed whole is written.
    const { id: _id, ...clone } = made;
    await expect(table().insert({ ...clone, label: 'clone' })).rejects.toThrow(
      /password: is required, sealed, and missing/,
    );
    // A copy that keeps the descriptors — the row a handler mutates and hands back.
    const edited: { password: string; token: string | null } = Object.defineProperties(
      { password: '', token: null },
      Object.getOwnPropertyDescriptors(made),
    );
    edited.password = 'rotated';
    edited.token = 'tok-new';
    const written = await table().update(made.id, edited);
    expect([written.password, written.token]).toEqual(['rotated', 'tok-new']);
  });

  test('the row round-trips and the server holds no plaintext', async () => {
    const made = await table().insert({
      label: 'live',
      password: 'hunter2',
      token: 'tok-live',
      email: 'live@example.com',
    });
    expect(made).toMatchObject({ password: 'hunter2', token: 'tok-live' });
    const [stored] = await client.query<Record<string, unknown>>(
      raw(`select * from pg_sealed_vault where id = '${made.id}'`),
    );
    expect(JSON.stringify(stored)).not.toMatch(/hunter2|tok-live|live@example\.com/);
    expect(isSealed(stored?.['password'])).toBe(true);
    expect(isSealed(stored?.['email'])).toBe(true);
    expect((await table().where({ id: made.id }).one())?.password).toBe('hunter2');
    expect((await table().update(made.id, { password: 'next' })).password).toBe('next');
  });

  test('the server`s own = finds a lookup value, and its UNIQUE refuses a second', async () => {
    const made = await table().insert({ label: 'a', password: 'p', email: 'find@example.com' });
    expect((await table().where({ email: 'find@example.com' }).one())?.id).toBe(made.id);
    expect(await table().where({ email: 'absent@example.com' }).one()).toBeNull();
    const again = () => table().insert({ label: 'b', password: 'p', email: 'find@example.com' });
    expect(await codeOf(again)).toBe('X_DB_UNIQUE_VIOLATION');
  });

  test('an opaque column is refused before a statement exists; a NULL test is answered', async () => {
    const repo = postgresDriver().repo(vault);
    const where = [{ column: 'password', op: 'eq' as const, value: 'p' }];
    expect(await codeOf(() => repo.findMany({ where }))).toBe('X_ENTITY_SEALED_PREDICATE');
    expect(
      await codeOf(() => repo.findMany({ orderBy: [{ column: 'email', direction: 'asc' }] })),
    ).toBe('X_ENTITY_SEALED_PREDICATE');
    const bare = await table().insert({ label: 'null', password: 'p', email: 'null@example.com' });
    const missing = await table().where({ label: 'null' }).andWhere('token', 'is-null').all();
    expect(missing.map((row) => row.id)).toEqual([bare.id]);
  });

  test('a rotation still finds the old row, and a dropped key refuses it by name', async () => {
    const before = await table().insert({ label: 'r', password: 'p', email: 'rot@example.com' });
    process.env[KEY_ENV] = generateMasterKey();
    process.env[RING_ENV] = firstKey;
    try {
      expect((await table().where({ email: 'rot@example.com' }).one())?.id).toBe(before.id);
      delete process.env[RING_ENV];
      expect(await codeOf(() => table().where({ id: before.id }).one())).toBe('X_SEAL_KEY_UNKNOWN');
    } finally {
      process.env[KEY_ENV] = firstKey;
      delete process.env[RING_ENV];
    }
  });

  test('a row left in the clear is X_SEAL_INVALID, never read as plaintext', async () => {
    const made = await table().insert({ label: 'c', password: 'p', email: 'clear@example.com' });
    await client.execute(
      raw(`update pg_sealed_vault set password = 'in-clear' where id = '${made.id}'`),
    );
    expect(await codeOf(() => table().where({ id: made.id }).one())).toBe('X_SEAL_INVALID');
  });
});
