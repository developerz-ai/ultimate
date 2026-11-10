// The conformance suite over the Postgres guard and a real server (`TEST_DATABASE_URL`): the
// memory run proves the checks, this one proves `on conflict do nothing` meets them — the race is
// the primary key's to decide. One worker database, the DDL applied once.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresTotpReplayGuard, SQL_TOTP_REPLAY_TABLE } from '@ultimat3/auth';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { postgresClient, raw } from '@ultimat3/db';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';
import { totpReplayGuardConformance } from './totp-replay-guard-conformance';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';

describe.skipIf(adminUrl === '')(testName('live', 'the postgres TOTP replay guard'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_totp_conformance' });
    client = postgresClient({ url: db.url });
    for (const piece of SQL_TOTP_REPLAY_TABLE.split(';')) {
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

  behavesLike(totpReplayGuardConformance, () => postgresTotpReplayGuard({ executor }));
});
