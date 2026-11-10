// The idempotency-store suite over `postgresIdempotencyStore` and a real Postgres
// (`TEST_DATABASE_URL`): a pool of several connections, so the reservation really is on another
// connection than the handler's transaction — the one thing the memory run cannot show.

import { afterAll, beforeAll, describe } from 'bun:test';
import { postgresIdempotencyStore, SQL_IDEMPOTENCY_TABLE } from '@ultimat3/action';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw, sql } from '@ultimat3/db';
import type { IdempotencyStoreSubject } from './idempotency-store-conformance';
import { idempotencyStoreConformance } from './idempotency-store-conformance';
import { behavesLike } from './shared-examples';
import type { WorkerDatabase } from './template-db';
import { acquireWorkerDatabase } from './template-db';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
const RECLAIM_MS = 30_000;

describe.skipIf(adminUrl === '')(testName('live', 'the postgres idempotency store'), () => {
  let db: WorkerDatabase | undefined;
  let client: PostgresClient | undefined;
  let subject: IdempotencyStoreSubject | undefined;

  beforeAll(async () => {
    db = await acquireWorkerDatabase({ adminUrl, templateName: 'ultimate_idem_conformance' });
    const pool = postgresClient({ url: db.url, role: 'web', profile: { max: 8 } });
    client = pool;
    for (const statement of SQL_IDEMPOTENCY_TABLE.split(';')) {
      if (statement.trim().length > 0) await pool.execute(raw(statement));
    }
    subject = {
      store: postgresIdempotencyStore({
        executor: dbExecutor(() => pool),
        origin: () => pool,
        reclaimAfterMs: () => RECLAIM_MS,
      }),
      client: pool,
      reclaimAfterMs: RECLAIM_MS,
      // The database's clock is the store's: the record is made older, never the clock moved.
      age: async (key, ms) => {
        await pool.execute(
          sql`update x_idempotency set created_at = created_at - (${ms}::bigint * interval '1 millisecond') where key = ${key}`,
        );
      },
      // Every check mints its own key; nothing to clear between them.
      reset: () => Promise.resolve(),
    };
  });

  // Both run, whatever the first does; the first failure is the one reported.
  afterAll(async () => {
    const failures: unknown[] = [];
    await Promise.resolve(client?.close()).catch((error: unknown) => failures.push(error));
    await Promise.resolve(db?.drop()).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) throw failures[0];
  });

  behavesLike(idempotencyStoreConformance, () => subject as IdempotencyStoreSubject);
});
