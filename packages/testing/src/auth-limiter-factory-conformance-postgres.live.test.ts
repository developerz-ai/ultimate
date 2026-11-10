// The conformance suite over the Postgres limiter and a real server (`TEST_DATABASE_URL`): the
// memory run proves the checks, this one proves the one-statement take meets them — two limiters
// over one table are two replicas, and the burst is the row lock's to serialise.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresAuthLimiter, SQL_AUTH_LIMIT_TABLES } from '@ultimat3/auth';
import type { PgExecutor } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { authLimiterFactoryConformance } from './auth-limiter-factory-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres auth limiter'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  // One clock for the file: every check names its own keys, and time only moves forward.
  const clock = frozenClock(1_700_000_000_000);

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_auth_limit_conformance' });
    client = postgresClient({ url: db.url });
    await client.execute(raw(SQL_AUTH_LIMIT_TABLES));
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

  behavesLike(authLimiterFactoryConformance, () => ({
    factory: (policy) => postgresAuthLimiter({ executor, clock, policy }),
    clock,
  }));
});
