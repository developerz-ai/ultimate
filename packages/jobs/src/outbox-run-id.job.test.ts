// The stage-time ids against the PG outbox store, the PG driver and a real Postgres — the
// embedded one, with this package's own DDL applied. `outbox-run-id.test.ts` proves the logic on
// the memory pair; this proves the statements: `x_outbox.run_id`, `SQL_OUTBOX_CLAIM` carrying it,
// and `SQL_ENQUEUE` refusing to insert a second row under an id that already names one. Opt-in
// (`.job.`): booting Postgres costs seconds.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { Tx } from '@ultimat3/entity';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { claimOf } from './driver';
import { createPgDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';
import { job, resetJobs } from './job';
import { createJobsFacade } from './outbox';
import { createPgOutboxStore } from './outbox-pg';
import { createOutboxRelay } from './outbox-relay';

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

afterEach(() => {
  resetJobs();
});

afterAll(async () => {
  await (await embeddedPg()).close();
});

describe('pg: an enqueue inside a transaction names the job its commit creates', () => {
  test('the staged ids are the published row’s, and a repeated publish adds nothing', async () => {
    const pg = await embeddedPg();
    await pg.reset();
    const driver = createPgDriver({ executor: pg.executor });
    const sync = job<{ requestId: string }>({
      tenant: 'none',
      name: 'syncAccount',
      input: passthrough<{ requestId: string }>(),
      idempotencyKey: ({ requestId }) => `sync:${requestId}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });

    let bound: PgExecutor | undefined;
    const tx = { id: 'tx-1' } as unknown as Tx;
    const store = createPgOutboxStore({
      executor: pg.executor,
      txExecutor: () => bound ?? expect.unreachable('staged outside the transaction'),
    });
    const jobs = createJobsFacade({ store, driver }, () => tx);

    let queued = { id: '', runId: '', deduped: true };
    await pg.transaction(async (executor) => {
      bound = executor;
      queued = await jobs.enqueue(sync, { requestId: 'r1' });
    });
    expect(queued.deduped).toBe(false);

    const relay = createOutboxRelay({ store, driver });
    expect(await relay.tick()).toBe(1);
    const row = await driver.introspect?.job(queued.id);
    expect(row?.runId).toBe(queued.runId);

    // The job finishes — out of the live states the idempotency index covers — and the relay's
    // publish is repeated, as it is after a crash before `markPublished`.
    const [claimed] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'worker-a',
    });
    if (claimed === undefined) return expect.unreachable('the published job was not claimable');
    await driver.ack(claimed.id, claimOf(claimed));
    const again = await driver.enqueue({
      id: queued.id,
      runId: queued.runId,
      name: sync.name,
      queue: 'default',
      input: { requestId: 'r1' },
      idempotencyKey: 'sync:r1',
      maxAttempts: 1,
    });

    expect(again).toEqual({ id: queued.id, runId: queued.runId, deduped: true });
    expect(await driver.introspect?.list()).toHaveLength(1);
  });
});
