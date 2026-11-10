// The conformance suite over the Postgres store and a real server (`TEST_DATABASE_URL`): the
// memory run proves the checks, this one proves the statements meet them — every race is a row
// lock's to decide. One worker database, the DDL applied twice, as every boot applies it.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresAuthServerStore, SQL_AUTH_SERVER_TABLES } from '@ultimat3/auth';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { authServerStoreConformance } from './auth-server-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(
  testName('live', 'the postgres authorization-server store'),
  () => {
    let db: WorkerDatabase | undefined;
    let client: PostgresClient | undefined;

    beforeAll(async () => {
      db = await acquireWorkerDatabase({
        adminUrl,
        templateName: 'ultimate_auth_server_conformance',
      });
      client = postgresClient({ url: db.url });
      for (let pass = 0; pass < 2; pass += 1) {
        for (const piece of SQL_AUTH_SERVER_TABLES.split(';')) {
          if (piece.trim().length > 0) await client.execute(raw(piece));
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

    const executor: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        (client as PostgresClient).query<R>({ text, values }),
    };

    behavesLike(authServerStoreConformance, () => postgresAuthServerStore({ executor }));
  },
);
