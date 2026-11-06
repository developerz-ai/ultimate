// The Postgres error-group store against a REAL Postgres (embedded PGlite): the same contract the
// memory twin keeps, and the property only a database can show — a report raised inside a
// transaction that rolls back keeps its group, because the sink writes outside it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { errorReport, UltimateError } from '@ultimat3/core';
import {
  db,
  type PgliteClient,
  pgliteClient,
  raw,
  setDbClient,
  withTransaction,
} from '@ultimat3/db';
import { STORE_CASES } from './error-groups-fixture';
import { postgresErrorGroupsStore } from './error-groups-pg';
import { SQL_ERROR_GROUPS_TABLE } from './error-groups-schema';
import { errorGroupsSink } from './error-groups-sink';

// A WASM compile plus an initdb, against bun's 5s default — a hang detector, not a budget.
const PGLITE_BOOT_MS = 60_000;

let client: PgliteClient;

beforeAll(async () => {
  client = pgliteClient();
  for (const statement of SQL_ERROR_GROUPS_TABLE.split(';')) {
    if (statement.trim().length > 0) await client.execute(raw(statement));
  }
  setDbClient(client);
}, PGLITE_BOOT_MS);

afterAll(async () => {
  setDbClient(undefined);
  await client.close();
});

describe('contract · postgresErrorGroupsStore', () => {
  STORE_CASES.forEach(({ name, run }, index) => {
    test(name, () => run(postgresErrorGroupsStore({ client }), `pg${index}-`));
  });

  test('the DDL is idempotent: a second boot applies it again', async () => {
    for (const statement of SQL_ERROR_GROUPS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
  });

  test('a report inside a transaction that rolls back keeps its group', async () => {
    const store = postgresErrorGroupsStore();
    const sink = errorGroupsSink({ store });
    const failure = new UltimateError({
      code: 'X_REFUND_FAILED',
      cause: 'the refund was refused',
      fix: 'x jobs show refunds --json',
    });
    const rolledBack = withTransaction(async () => {
      await db().execute(raw('select 1'));
      sink.report(errorReport(failure, { source: 'http', scope: { operation: 'POST /refunds' } }));
      throw failure;
    });
    await expect(rolledBack).rejects.toBe(failure);
    await sink.settled();
    const groups = (await store.list()).filter((group) => group.code === 'X_REFUND_FAILED');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(1);
  });
});
