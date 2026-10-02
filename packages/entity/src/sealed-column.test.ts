// A sealed column, end to end and in BOTH drivers: `memoryDriver()` and `postgresDriver()` over an
// embedded Postgres (PGlite). What every case guards is one rule — the row reads the plaintext,
// the database never holds it, and nothing the database would have to compare may name it.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { generateMasterKey, isSealed, isUltimateError } from '@ultimat3/core';
import {
  createPgliteClient,
  generateMigration,
  raw,
  setDbClient,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { type Driver, database, memoryDriver } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';
import { sealedFields } from './sealed';

const PGLITE_BOOT_MS = 30_000;
// Every case here is a handful of embedded-Postgres statements; on a loaded machine one of them
// passed Bun's 5 s default with nothing wrong. The boot's own budget is the honest ceiling.
setDefaultTimeout(PGLITE_BOOT_MS);
const KEY_ENV = 'ULTIMATE_SECRETS_KEY';
const RING_ENV = 'ULTIMATE_SECRETS_RETIRED_KEYS';

const connections = entity('sc_connections', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    password: text({ max: 12 }).sealed(),
    token: text().nullable().sealed(),
    email: text().sealed({ lookup: true }).unique(),
  },
});

const ENTITIES = { connections };
const client = createPgliteClient();
const previousKey = process.env[KEY_ENV];
const previousRing = process.env[RING_ENV];
const firstKey = generateMasterKey();

beforeAll(async () => {
  process.env[KEY_ENV] = firstKey;
  delete process.env[RING_ENV];
  setDbClient(client);
  const migration = generateMigration({
    entities: Object.values(ENTITIES).map((one) => one.$describe()),
    name: 'sealed column',
    now: new Date('2026-10-01T00:00:00.000Z'),
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
}, PGLITE_BOOT_MS);

afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  if (previousRing === undefined) delete process.env[RING_ENV];
  else process.env[RING_ENV] = previousRing;
  clearRegistry();
});

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return isUltimateError(error) ? error.code : `not an UltimateError`;
  }
  return 'resolved';
};

const refusal = async (run: () => Promise<unknown>): Promise<{ cause: string; fix: string }> => {
  try {
    await run();
  } catch (error) {
    if (isUltimateError(error)) return { cause: String(error.cause), fix: error.fix };
  }
  return expect.unreachable('the call was expected to refuse with an UltimateError');
};

const DRIVERS: readonly (readonly [string, () => Driver])[] = [
  ['memory', () => memoryDriver()],
  ['postgres', () => postgresDriver()],
];

describe.each(DRIVERS)('unit · a sealed column on %s', (name, driver) => {
  const db = () => database(ENTITIES, { driver: driver() });
  const mail = (local: string): string => `${local}.${name}@example.com`;

  test('the row round-trips the plaintext through insert, read and update', async () => {
    const table = db().connections;
    const made = await table.insert({
      label: 'primary',
      password: 'hunter2',
      email: mail('round'),
    });
    expect(made.password).toBe('hunter2');
    expect(made.token).toBeNull();
    const read = await table.where({ id: made.id }).one();
    expect(read).toMatchObject({ password: 'hunter2', email: mail('round'), token: null });
    const updated = await table.update(made.id, { password: 'correct', token: 'tok-1' });
    expect(updated).toMatchObject({ password: 'correct', token: 'tok-1' });
    // `null` clears a sealed column exactly as it clears any other.
    expect((await table.update(made.id, { token: null })).token).toBeNull();
    const projected = await table.where({ id: made.id }).select({ id: true, password: true }).one();
    // Named, so it is there to read — and still nothing a serialiser enumerates.
    expect(projected?.password).toBe('correct');
    expect<unknown>(projected).toEqual({ id: made.id });
  });

  test('the plaintext bound still holds, though the stored string is longer than it', async () => {
    const table = db().connections;
    const long = { label: 'x', password: 'thirteen-char', email: mail('long') };
    expect(await codeOf(() => table.insert(long))).toBe('X_INVARIANT_VIOLATED');
    // …and for a caller holding the repository itself, which never ran `$parse`.
    const repo = driver().repo(connections);
    expect(await codeOf(() => repo.insert({ ...long, id: crypto.randomUUID(), token: null }))).toBe(
      'X_INVARIANT_VIOLATED',
    );
  });

  test('an opaque column is refused wherever the database would compare it', async () => {
    const repo = driver().repo(connections);
    const where = [{ column: 'password', op: 'eq' as const, value: 'hunter2' }];
    const refused = await refusal(() => repo.findMany({ where }));
    expect(refused.cause).toContain('sc_connections.password is sealed');
    expect(refused.fix).toContain('text().sealed({ lookup: true })');
    expect(refused.fix).toContain('visibly equal');
    const order = [{ column: 'password', direction: 'asc' as const }];
    for (const run of [
      () => repo.findMany({ where }),
      () => repo.count({ where }),
      () => repo.findMany({ orderBy: order }),
      () => repo.countBy('password'),
      () => repo.aggregate('max', 'password'),
      () => repo.deleteWhere({ password: 'hunter2' }),
      () => repo.updateWhere({ password: 'hunter2' }, { label: 'y' }),
      () => repo.approximateCount({ where }),
    ]) {
      expect(await codeOf(run)).toBe('X_ENTITY_SEALED_PREDICATE');
    }
  });

  test('presence is not a secret: a NULL test reads any sealed column', async () => {
    const table = db().connections;
    const without = await table.insert({ label: 'n', password: 'p', email: mail('null') });
    const withToken = await table.insert({
      label: 'n',
      password: 'p',
      token: 't',
      email: mail('notnull'),
    });
    // `token` is OPAQUE. NULL is stored as NULL, never sealed, so the database can answer this —
    // and it is how a backfill visits only the rows still to be sealed.
    const missing = await table.where({ label: 'n' }).andWhere('token', 'is-null').all();
    expect(missing.map((row) => row.id)).toContain(without.id);
    expect(missing.map((row) => row.id)).not.toContain(withToken.id);
    const present = await table.where({ label: 'n' }).andWhere('token', 'is-not-null').all();
    expect(present.map((row) => row.id)).toEqual([withToken.id]);
    expect(present[0]?.token).toBe('t');
  });

  test('a lookup column finds its row by equality and by nothing else', async () => {
    const table = db().connections;
    const a = await table.insert({ label: 'a', password: 'p', email: mail('a') });
    const b = await table.insert({ label: 'b', password: 'p', email: mail('b') });
    expect((await table.where({ email: mail('a') }).one())?.id).toBe(a.id);
    const both = await table.andWhere('email', 'in', [mail('a'), mail('b')]).all();
    expect(both.map((row) => row.id).sort()).toEqual([a.id, b.id].sort());
    expect(await table.where({ email: mail('nobody') }).one()).toBeNull();
    expect(await table.where({ email: mail('a') }).count()).toBe(1);

    const repo = driver().repo(connections);
    const like = [{ column: 'email', op: 'like' as const, value: '%@example.com' }];
    const refused = await refusal(() => repo.findMany({ where: like }));
    expect(refused.cause).toContain('sealed for lookup');
    expect(refused.fix).toContain("andWhere('email', 'in', values)");
    for (const run of [
      () => repo.findMany({ where: [{ column: 'email', op: 'gt' as const, value: 'a' }] }),
      () => repo.findMany({ where: [{ column: 'email', op: 'neq' as const, value: 'a' }] }),
      () => repo.findMany({ orderBy: [{ column: 'email', direction: 'asc' as const }] }),
      () => repo.countBy('email'),
      () => repo.deleteWhere({ email: mail('a') }),
    ]) {
      expect(await codeOf(run)).toBe('X_ENTITY_SEALED_PREDICATE');
    }
  });

  test('.unique() on a lookup column is enforced over the stored strings', async () => {
    const table = db().connections;
    await table.insert({ label: 'one', password: 'p', email: mail('dup') });
    expect(
      await codeOf(() => table.insert({ label: 'two', password: 'p', email: mail('dup') })),
    ).toBe('X_DB_UNIQUE_VIOLATION');
  });

  test('a row written before a rotation is still found while the old key is declared', async () => {
    const table = db().connections;
    const before = await table.insert({ label: 'old', password: 'p', email: mail('rot') });
    const next = generateMasterKey();
    process.env[KEY_ENV] = next;
    process.env[RING_ENV] = firstKey;
    try {
      const after = await table.insert({ label: 'new', password: 'p', email: mail('rot2') });
      // Equality expands to one candidate per declared key, so both generations are found.
      expect((await table.where({ email: mail('rot') }).one())?.id).toBe(before.id);
      expect((await table.where({ email: mail('rot2') }).one())?.id).toBe(after.id);
      expect((await table.where({ id: before.id }).one())?.password).toBe('p');
      // Drop the retired key before the re-seal: the old row names a key nobody declares.
      delete process.env[RING_ENV];
      expect(await codeOf(() => table.where({ id: before.id }).one())).toBe('X_SEAL_KEY_UNKNOWN');
      expect((await table.where({ id: after.id }).one())?.password).toBe('p');
    } finally {
      process.env[KEY_ENV] = firstKey;
      delete process.env[RING_ENV];
    }
  });

  test('no master key refuses the write — the plaintext is never stored instead', async () => {
    const table = db().connections;
    delete process.env[KEY_ENV];
    try {
      const write = () => table.insert({ label: 'k', password: 'p', email: mail('nokey') });
      expect(await codeOf(write)).toBe('X_SEAL_KEY_MISSING');
    } finally {
      process.env[KEY_ENV] = firstKey;
    }
    expect(await table.where({ email: mail('nokey') }).one()).toBeNull();
  });
});

describe('unit · what the database holds', () => {
  test('a raw select shows no plaintext, and the DDL is plain text with no length CHECK', async () => {
    const table = database(ENTITIES, { driver: postgresDriver() }).connections;
    const made = await table.insert({
      label: 'raw',
      password: 'hunter2',
      token: 'tok-raw',
      email: 'raw@example.com',
    });
    const [stored] = await client.query<Record<string, unknown>>(
      raw(`select * from sc_connections where id = '${made.id}'`),
    );
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('tok-raw');
    expect(JSON.stringify(stored)).not.toContain('raw@example.com');
    expect(isSealed(stored?.['password'])).toBe(true);
    expect(isSealed(stored?.['email'])).toBe(true);
    expect(stored?.['label']).toBe('raw');

    const ddl = generateMigration({
      entities: [connections.$describe()],
      name: 'ddl',
      now: new Date('2026-10-01T00:00:00.000Z'),
    }).up;
    expect(ddl).toMatch(/"password" text not null/);
    expect(ddl).toMatch(/"token" text(,|\n)/);
    // The plain column keeps its bound; the sealed one has none the database could apply.
    expect(ddl).toContain('char_length(label) <= 40');
    expect(ddl).not.toContain('char_length(password)');
  });

  test('a stored value that is not a sealed value is X_SEAL_INVALID, never read as plaintext', async () => {
    const table = database(ENTITIES, { driver: postgresDriver() }).connections;
    const made = await table.insert({ label: 'plain', password: 'p', email: 'plain@example.com' });
    await client.execute(
      raw(`update sc_connections set password = 'left-in-clear' where id = '${made.id}'`),
    );
    expect(await codeOf(() => table.where({ id: made.id }).one())).toBe('X_SEAL_INVALID');
  });

  test('a value moved from one sealed column to another does not open there', async () => {
    const table = database(ENTITIES, { driver: postgresDriver() }).connections;
    const made = await table.insert({
      label: 'swap',
      password: 'p',
      token: 't',
      email: 'swap@example.com',
    });
    await client.execute(raw(`update sc_connections set token = password where id = '${made.id}'`));
    // The purpose is `entity:<table>.<column>`, bound into the tag: derived, so never shared.
    expect(await codeOf(() => table.where({ id: made.id }).one())).toBe('X_SEAL_INVALID');
    expect(sealedFields(connections).map((field) => field.purpose)).toEqual([
      'entity:sc_connections.password',
      'entity:sc_connections.token',
      'entity:sc_connections.email',
    ]);
  });
});
