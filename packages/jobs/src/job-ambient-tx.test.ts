// Whether a job body or a `step.run` inherits the async-local scope the worker was STARTED under.
// It does: `AsyncLocalStorage` propagates into every timer begun under it, so a worker started
// inside `withTransaction` carries that transaction into its poll loop and the body sees it as
// `currentTx()`, both in the body and in `step.run`. A body that wants a fresh transaction opens
// `withTransaction` of its own; a body that wants none is started outside any, or escapes with
// `outsideTransaction`.

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

describe('a job inherits the ambient context it was started under', () => {
  test('the body and a step see no transaction when the worker was started outside any', async () => {
    const seen = await observe(async (begin) => begin());
    expect(seen).toEqual([undefined, undefined]);
  });

  test('the body and a step see the starter transaction when the worker was started inside one', async () => {
    let starterTx: unknown;
    const seen = await observe(async (begin) => {
      await withTransaction(async () => {
        starterTx = currentTx();
        begin();
      });
    });
    expect(starterTx).toBeDefined();
    expect(seen).toEqual([starterTx, starterTx]);
  });
});
