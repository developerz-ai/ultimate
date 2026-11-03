// The probe, inverted: a reader holding a table past one `lock_timeout`. It printed
// `X_DB_LOCK_TIMEOUT at 3015 ms, deploy failed, no retry`; now the migration waits its turn.

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError, probeDatabaseName } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { type Migration, migrate } from './migrate';
import { raw } from './sql';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const SCRATCH = probeDatabaseName('ult_lockretry');

describe.skipIf(!hasPostgres)('live · migrate retries a lost lock wait', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let reader: PostgresClient;
  const ids: string[] = [];

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '' });
    await admin.execute(raw(`create database "${SCRATCH}"`));
    const scoped = new URL(url ?? '');
    scoped.pathname = `/${SCRATCH}`;
    client = postgresClient({ url: scoped.toString() });
    reader = postgresClient({ url: scoped.toString() });
    await client.execute(raw('create table lr_posts (id int primary key)'));
  });

  afterEach(async () => {
    await client.execute(raw('drop table if exists x_migrations'));
  });

  afterAll(async () => {
    await client.close();
    await reader.close();
    await admin.execute(raw(`drop database "${SCRATCH}" with (force)`));
    await admin.close();
  });

  /** One transaction holding ACCESS SHARE for `ms`, which an ALTER has to queue behind. */
  const holdFor = async (ms: number): Promise<{ readonly released: Promise<void> }> => {
    const locked = Promise.withResolvers<void>();
    const released = withTransaction(
      async (tx) => {
        await tx.execute(raw(`select * from lr_posts`));
        locked.resolve();
        await tx.execute(raw(`select pg_sleep(${ms / 1000})`));
      },
      { client: reader },
    );
    await locked.promise;
    return { released };
  };

  const alter = (name: string): Migration => {
    ids.push(name);
    return { id: name, name, up: `alter table lr_posts add column ${name} text;`, down: '' };
  };

  test('a reader held past one timeout: the migration waits it out and applies', async () => {
    const held = await holdFor(500);
    const report = await migrate({
      migrations: [alter('c1')],
      client,
      lockTimeoutMs: 100,
      lockRetries: 10,
      appVersion: 'test',
    });
    await held.released;
    expect(report.applied.map((row) => row.id)).toEqual(['c1']);
    const rows = await client.query<{ id: string }>(raw('select id from x_migrations'));
    expect(rows.map((row) => row.id)).toEqual(['c1']);
  });

  test('held past all attempts: X_DB_LOCK_TIMEOUT stating them, and no ledger row', async () => {
    const held = await holdFor(1500);
    let thrown: unknown;
    try {
      await migrate({
        migrations: [alter('c2')],
        client,
        lockTimeoutMs: 50,
        lockRetries: 2,
        appVersion: 'test',
      });
    } catch (error) {
      thrown = error;
    }
    await held.released;
    expect(isUltimateError(thrown) ? thrown.code : '').toBe('X_DB_LOCK_TIMEOUT');
    expect(isUltimateError(thrown) ? thrown.cause : '').toContain('3 attempts');
    const rows = await client.query<{ id: string }>(raw('select id from x_migrations'));
    expect(rows).toEqual([]);
  });
});
