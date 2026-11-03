// The probe that made this slice, inverted: two releases of one entity on one table, across a real
// drop, following the printed fix. Before `retired` the N-1 entity read and wrote a column the
// generated drop had just removed, and both answered X_DB_SCHEMA_STALE: no zero-downtime drop existed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError, probeDatabaseName } from '@ultimat3/core';
import {
  type EntityDescriptionLike,
  type GeneratedMigration,
  generateMigration,
  type Migration,
  migrate,
  type PostgresClient,
  postgresClient,
  raw,
  type SchemaDescription,
  setDbClient,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { database } from './database';
import { entity } from './entity';
import { postgresDriver } from './pg-driver';
import { clearRegistry } from './registry';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'retired_live_posts';
// A database of its own: `migrate()` owns a ledger and the migration lock, and this suite must not
// race a sibling for either, nor audit a sibling's rows as foreign.
const SCRATCH = probeDatabaseName('ult_retired');

const before = entity(TABLE, {
  columns: { id: uuid().primaryKey(), title: text(), legacy: text().nullable() },
});
const old = database({ posts: before }, { driver: postgresDriver() });

const newColumns = () => ({ id: uuid().primaryKey(), title: text() });

const toMigration = (id: string, generated: GeneratedMigration): Migration => ({
  id,
  name: generated.name,
  up: generated.up,
  down: generated.down,
  snapshot: generated.snapshot,
});

describe.skipIf(!hasPostgres)('live · a column drops across two releases', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  const applied: Migration[] = [];

  const apply = async (id: string, generated: GeneratedMigration): Promise<void> => {
    applied.push(toMigration(`retired_live_${id}`, generated));
    await migrate({ migrations: applied, client, appVersion: 'test', production: true });
  };

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '' });
    await admin.execute(raw(`create database "${SCRATCH}"`));
    const scoped = new URL(url ?? '');
    scoped.pathname = `/${SCRATCH}`;
    client = postgresClient({ url: scoped.toString() });
    setDbClient(client);
  });

  afterAll(async () => {
    setDbClient(undefined);
    await client.close();
    await admin.execute(raw(`drop database "${SCRATCH}" with (force)`));
    await admin.close();
  });

  test('neither release ever reads a column that is gone', async () => {
    // Release 1: the table, with the column.
    const initial = generateMigration({ entities: [before.$describe()], name: 'init' });
    await apply('1_init', initial);
    await old.posts.insert({ id: crypto.randomUUID(), title: 'one', legacy: 'kept' });

    // Release 2: retired. The new release stops naming it, the old one still works.
    const retiredEntity = entity(`${TABLE}_v2`, {
      table: TABLE,
      columns: newColumns(),
      retired: ['legacy'],
    });
    const retiring = generateMigration({
      entities: [retiredEntity.$describe() as EntityDescriptionLike],
      current: initial.snapshot,
      name: 'retire legacy',
    });
    expect(retiring.up).toBe(`-- retires "${TABLE}"."legacy"`);
    await apply('2_retire', retiring);

    const fresh = database({ posts: retiredEntity }, { driver: postgresDriver() });
    await fresh.posts.insert({ id: crypto.randomUUID(), title: 'two' });
    await old.posts.insert({ id: crypto.randomUUID(), title: 'three', legacy: 'still' });
    expect((await old.posts.limit(10).page()).rows.length).toBe(3);
    expect((await fresh.posts.limit(10).page()).rows.length).toBe(3);

    // Release 3, once the old pods are gone: the printed path, flag and all.
    const dropped = entity(`${TABLE}_v3`, { table: TABLE, columns: newColumns() });
    const current: SchemaDescription = retiring.snapshot;
    const dropping = generateMigration({
      entities: [dropped.$describe() as EntityDescriptionLike],
      current,
      name: 'drop legacy',
      allowDestructive: true,
    });
    await apply('3_drop', dropping);
    const after = database({ posts: dropped }, { driver: postgresDriver() });
    expect((await after.posts.limit(10).page()).rows.length).toBe(3);
    await fresh.posts.insert({ id: crypto.randomUUID(), title: 'four' });

    // The probe itself, unchanged: the old release is now what it would have been on day one.
    let code = 'resolved';
    try {
      await old.posts.limit(1).page();
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_DB_SCHEMA_STALE');
  });

  test('retire and its drop pending together are refused in production, on a non-empty ledger', async () => {
    const id = (name: string) => `retired_live_pair_${name}`;
    const migrations: Migration[] = [{ id: id('a'), name: 'a', up: 'select 1;', down: '' }];
    await migrate({ migrations: [...applied, ...migrations], client, appVersion: 'test' });
    const both: Migration[] = [
      ...applied,
      ...migrations,
      { id: id('b'), name: 'b', up: `-- retires "${TABLE}"."title"`, down: '' },
      {
        id: id('c'),
        name: 'c',
        up: `-- contracts "${TABLE}"."title"\nalter table "${TABLE}" drop column "title";`,
        down: '',
      },
    ];
    let code = 'resolved';
    try {
      await migrate({ migrations: both, client, appVersion: 'test', production: true });
    } catch (error) {
      code = isUltimateError(error) ? error.code : 'not an UltimateError';
    }
    expect(code).toBe('X_MIGRATION_ROLLING_UNSAFE');
    const rows = await client.query<{ id: string }>(
      raw(`select id from x_migrations where id = '${id('b')}'`),
    );
    expect(rows.length).toBe(0);
  });
});

// Outside the block and unconditional: bun runs no hook inside a skipped `describe`.
afterAll(() => {
  clearRegistry();
});
