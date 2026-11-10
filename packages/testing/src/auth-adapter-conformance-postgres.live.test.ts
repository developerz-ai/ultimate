// The conformance suite over the Postgres adapter and a real server (`TEST_DATABASE_URL`): the
// unit run already covers it on PGlite; this one proves the statements on the server production
// runs, whose collation and concurrency PGlite does not have. One worker database, `AUTH_TABLES`
// applied twice, as every boot applies them.

import { afterAll, beforeAll, describe } from 'bun:test';
import { AUTH_TABLES, postgresAuthAdapter } from '@ultimat3/auth';
import { frozenClock } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { authAdapterConformance } from './auth-adapter-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres auth adapter'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  const clock = frozenClock('2031-03-04T05:06:07.000Z');

  beforeAll(async () => {
    db = await acquireWorkerDatabase({
      adminUrl,
      templateName: 'ultimate_auth_adapter_conformance',
    });
    client = postgresClient({ url: db.url });
    for (let pass = 0; pass < 2; pass += 1) {
      for (const entry of AUTH_TABLES) {
        for (const statement of entry.split(';')) {
          if (statement.trim() !== '') await client.execute(raw(statement));
        }
      }
    }
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(authAdapterConformance, () => ({
    adapter: postgresAuthAdapter(client as PostgresClient, clock),
    clock,
  }));
});
