// Whether a job body or a `step.run` runs inside an AMBIENT transaction. It does not: the worker
// opens none, so `db()` inside a step is the pool and every write commits as its statement ends —
// "claim, then POST" commits the claim before the POST leaves. An app that wants a step's writes
// atomic opens `withTransaction` itself. The case that could break it is a worker STARTED inside
// a transaction scope (a test, a boot that runs inside one): `AsyncLocalStorage` propagates into
// every timer begun under it, so the poll loop would hand each job the starter's transaction —
// committed long ago — and `db()` would answer with it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type Ctx, ctxOf } from '@ultimat3/core';
import { currentTx, recordingClient, setDbClient, withTransaction } from '@ultimat3/db';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { jobWorker } from './worker';

const input: StandardSchemaV1<unknown, { id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as { id: string } }),
  },
};

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  expect.unreachable('the job never reached done');
}

beforeEach(() => {
  setDbClient(recordingClient());
});

afterEach(() => {
  resetJobs();
  setDbClient(undefined);
});

/** Runs one job through a real worker and answers what `currentTx()` said in the body and step. */
async function observe(start: (begin: () => void) => Promise<void>): Promise<readonly unknown[]> {
  const seen: unknown[] = [];
  const driver = memoryJobDriver();
  const handle = job<{ id: string }>({
    tenant: 'none',
    name: 'claimThenPost',
    input,
    idempotencyKey: ({ id }) => `claim:${id}`,
    retry: { attempts: 1, backoff: 'fixed', delay: 0, jitter: false },
    run: async ({ step }) => {
      seen.push(currentTx());
      await step.run('claim', async () => {
        seen.push(currentTx());
        return 'claimed';
      });
    },
  });
  await driver.enqueue({
    name: 'claimThenPost',
    queue: 'default',
    input: { id: 'r-1' },
    idempotencyKey: handle.idempotencyKeyFor({ id: 'r-1' }),
    maxAttempts: 1,
  });
  const worker = jobWorker({ driver, context, drainOnShutdown: false, pollIntervalMs: 5 });
  await start(() => worker.start());
  try {
    await waitFor(
      async () => ((await driver.introspect?.list({ state: 'done' })) ?? []).length > 0,
    );
  } finally {
    await worker.stop('test-end');
  }
  return seen;
}

describe('a job runs in no ambient transaction', () => {
  test('neither the body nor a step sees one', async () => {
    const seen = await observe(async (begin) => begin());
    expect(seen).toEqual([undefined, undefined]);
  });

  test('not even when the worker was started inside a transaction scope', async () => {
    const seen = await observe((begin) =>
      withTransaction(async () => {
        begin();
      }),
    );
    expect(seen).toEqual([undefined, undefined]);
  });
});
