// The outbox-store suite over `postgresOutboxStore()` and a real Postgres (`TEST_DATABASE_URL`): a
// row is staged on a pinned connection inside a real BEGIN, and each relay is its own store, so
// its own `relayId` — the fence two processes hold. `x_outbox` is emptied before every check, and a
// lease lapses by ageing `claimed_at`, never by a wait.

import { afterAll, beforeAll, describe, expect } from 'bun:test';
import type { DbConnection } from '@ultimat3/db';
import { raw } from '@ultimat3/db';
import type { Tx } from '@ultimat3/entity';
import { postgresOutboxStore } from '@ultimat3/jobs';
import { age, connectionExecutor, jobsDatabase } from './lease-store-conformance-pg-fixture';
import type { OutboxStoreSubject } from './outbox-store-conformance';
import { outboxStoreConformance } from './outbox-store-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const adminUrl = Bun.env['TEST_DATABASE_URL'] ?? '';
const LEASE_MS = 30_000;

describe.skipIf(adminUrl === '')(testName('live', 'the pg outbox store'), () => {
  const database = jobsDatabase(adminUrl, 'ultimate_outbox_conformance');
  beforeAll(database.open);
  afterAll(database.close);

  /** The connection each open transaction runs on: what `txExecutor` answers for its `Tx`. */
  const pinned = new WeakMap<Tx, DbConnection>();
  const txExecutor = (tx: Tx) =>
    connectionExecutor(pinned.get(tx) ?? expect.unreachable('stage() outside its transaction'));

  const subject = async (): Promise<OutboxStoreSubject> => {
    await database.execute('truncate x_outbox');
    return {
      relay: () =>
        postgresOutboxStore({ executor: database.executor, txExecutor, claimLeaseMs: LEASE_MS }),
      claimLeaseMs: LEASE_MS,
      elapse: (ms) => age(database, 'x_outbox', ['claimed_at'], ms),
      async transaction(outcome, body) {
        using connection = await database.reserve();
        const tx: Tx = { id: crypto.randomUUID(), onRollback: () => undefined };
        pinned.set(tx, connection);
        await connection.execute(raw('begin'));
        try {
          await body(tx);
        } catch (error) {
          await connection.execute(raw('rollback'));
          throw error;
        }
        await connection.execute(raw(outcome));
        return tx;
      },
    };
  };

  behavesLike(outboxStoreConformance, subject);
});
