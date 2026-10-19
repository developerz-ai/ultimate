// Whether a job body or a `step.run` runs inside the worker's AMBIENT transaction. It does:
// a worker started inside a `withTransaction` scope hands every body and every step that scope,
// because the AsyncLocalStorage the transaction rides on propagates into the poll loop's timers
// and into every promise the body returns. The framework's other primitives (`action`, `query`,
// `mutator`, the outbox relay) open their own `withTransaction` when they need one — a job body
// inherits, never opens, the caller's — so a body that escaped the ambient transaction would
// undo a property the rest of the framework already relies on. A worker started OUTSIDE any
// scope hands the body and step nothing: `currentTx()` answers `undefined`, and `db()` is the
// pool.

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

describe(`a job inherits its worker's ambient transaction`, () => {
  test('neither the body nor a step sees one when the worker is started outside any', async () => {
    const seen = await observe(async (begin) => begin());
    expect(seen).toEqual([undefined, undefined]);
  });

  test('the body and a step see the same scope the worker was started inside', async () => {
    let starterTx: unknown;
    const seen = await observe((begin) =>
      withTransaction(async () => {
        starterTx = currentTx();
        begin();
      }),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeDefined();
    expect(seen[0]).toBe(starterTx);
    expect(seen[1]).toBe(starterTx);
  });
});
