// The conformance suite over the Postgres store and a real server (`TEST_DATABASE_URL`): the memory
// run proves the checks, this one proves the one-statement take meets them — the race included,
// which only a server's row lock can answer. One worker database, the DDL applied once.

import { afterAll, beforeAll, describe } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { postgresRateLimitStore, SQL_RATE_LIMIT_TABLE } from '@ultimat3/http';
import { rateLimitStoreConformance } from './rate-limit-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
/**
 * Past the 250 ms default: a store that misses its deadline DEGRADES to this pod's memory, and a
 * check answered from memory would pass without the statement ever deciding it.
 */
const DEADLINE_MS = 10_000;

describe.skipIf(adminUrl === '')(testName('live', 'the postgres rate-limit store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_rate_limit_conformance' });
    client = postgresClient({ url: db.url });
    for (const piece of SQL_RATE_LIMIT_TABLE.split(';')) {
      if (piece.trim().length > 0) await client.execute(raw(piece));
    }
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  const executor: PgExecutor = {
    query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
      (client as PostgresClient).query<R>({ text, values }),
  };

  behavesLike(rateLimitStoreConformance, () =>
    postgresRateLimitStore({ executor, deadlineMs: DEADLINE_MS }),
  );
});
