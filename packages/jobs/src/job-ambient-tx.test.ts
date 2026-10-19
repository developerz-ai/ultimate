// Whether a job body or a `step.run` inherits the caller's ambient transaction. It does: the
// worker opens none of its own, and AsyncLocalStorage carries the caller's through every timer of
// the loop, so a worker started inside `withTransaction` (a test, a boot that ran inside one)
// hands each job that transaction — committed long ago — as ambient. `db()` answers with it; an
// enqueue staged inside the body rides the caller's outbox. An app that wants a step's writes
// independent opens its own `withTransaction` inside the body. Pre-#722 behaviour, pinned against
// a future rewrite that wants to drop the inheritance again — the e2e fixtures were written
// against it.

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

describe("a job inherits its caller's ambient transaction", () => {
  test('neither the body nor a step sees one when the worker is started outside any', async () => {
    const seen = await observe(async (begin) => begin());
    expect(seen).toEqual([undefined, undefined]);
  });

  test('the body and a step both see the same transaction the worker was started inside', async () => {
    const seen = await observe((begin) =>
      withTransaction(async () => {
        begin();
      }),
    );
    // AsyncLocalStorage rides through every timer the loop schedules, so the body and the step
    // both read the caller's transaction — and they read the SAME handle, not two snapshots.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
  });
});
