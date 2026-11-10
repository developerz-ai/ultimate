// Partition maintenance never takes a table down: a long reader holding the parent makes the
// maintenance step fail fast with `X_DB_LOCK_TIMEOUT` (retryable — the job's retry absorbs it)
// instead of queueing its ACCESS EXCLUSIVE lock and every insert and select behind it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { type PostgresClient, postgresClient } from './client';
import { generateMigration } from './generate';
import { partitionedEvents } from './generate-partition-fixture';
import { maintainPartitions } from './generate-partition-run';
import { raw } from './sql';
import { statementsOf } from './statement-split';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const TABLE = 'gp_lock_live';

describe.skipIf(!hasPostgres)('live · postgres · partition maintenance under a reader', () => {
  let client: PostgresClient;
  let reader: PostgresClient;

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    reader = postgresClient({ url: url ?? '' });
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    const { up } = generateMigration({ entities: [partitionedEvents(TABLE)], name: 'lock' });
    for (const statement of statementsOf(up)) await client.execute(raw(statement));
  });

  afterAll(async () => {
    await client.execute(raw(`drop table if exists "${TABLE}" cascade`));
    await reader.close();
    await client.close();
  });

  test('a reader holding the parent makes creation fail fast, and the table keeps serving', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const transaction = withTransaction(
      async (tx) => {
        await tx.query(raw(`select count(*) from "${TABLE}"`));
        opened();
        await held;
      },
      { client: reader },
    );
    await reading;
    const started = performance.now();
    let code: unknown = 'resolved';
    try {
      // A year on: a partition must be created, which needs ACCESS EXCLUSIVE on the parent.
      await maintainPartitions(client, partitionedEvents(TABLE), new Date(Date.now() + 4e10), {
        lockTimeoutMs: 200,
      });
    } catch (error) {
      code = isUltimateError(error) ? error.code : String(error);
    }
    const waited = performance.now() - started;
    release();
    await transaction;
    expect(code).toBe('X_DB_LOCK_TIMEOUT');
    expect(waited).toBeLessThan(3000);
  });
});
