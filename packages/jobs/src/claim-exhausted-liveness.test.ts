// A burial's tellings run BESIDE the claim pass, never inside it: the loop's heartbeat judges the
// pass, and a job whose `onSettled` may take minutes (`onSettledTimeout: '5m'`) held the pass open
// past the worker's liveness bound — `/healthz` 503 on a healthy worker, a restart loop.

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { resetJobDriver } from './adapter';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { useFakeTime } from './fake-time-fixture';
import { job, resetJobs } from './job';
import { LIVENESS_FLOOR_MS, staleLoops } from './loop-heartbeat';
import { jobWorker } from './worker';

interface OrgInput {
  readonly orgId: string;
}

const passthrough: StandardSchemaV1<unknown, OrgInput> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as OrgInput }),
  },
};

const context = () => ctxOf({ role: 'worker', buildId: 'test' });
const time = useFakeTime();

afterEach(() => {
  resetJobs();
  resetJobDriver();
  mock.restore();
});

/** A row whose final attempt a dead worker held, of a job whose hook blocks until released. */
async function buriedRow(): Promise<{
  readonly driver: JobDriver;
  readonly entered: () => boolean;
  readonly release: () => void;
}> {
  let entered = false;
  let release = (): void => undefined;
  job<OrgInput>({
    name: 'notifyOrg',
    tenant: 'none',
    input: passthrough,
    idempotencyKey: ({ orgId }) => `notify:${orgId}`,
    retry: { attempts: 1 },
    onSettledTimeout: '5m',
    run: () => Promise.resolve(),
    onSettled: () => {
      entered = true;
      return new Promise<void>((done) => (release = done));
    },
  });
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: 'notifyOrg',
    queue: 'default',
    input: { orgId: 'org-7' },
    idempotencyKey: 'notify:org-7',
    maxAttempts: 1,
  });
  const gone = { queues: ['default'], limit: 1, workerId: 'gone', visibilityTimeoutMs: 0 };
  expect(await driver.claim(gone)).toHaveLength(1);
  return { driver, entered: () => entered, release: () => release() };
}

describe('unit · a burial telling and the worker liveness', () => {
  test('a five-minute onSettled told for a burial never turns the worker stale', async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const row = await buriedRow();
    const worker = jobWorker({
      driver: row.driver,
      pollIntervalMs: 25,
      context,
      drainOnShutdown: false,
    });
    worker.start();
    try {
      await time.until(row.entered);
      await time.advance(LIVENESS_FLOOR_MS + 60_000, 1_000);
      expect(staleLoops()).toEqual([]);
    } finally {
      row.release();
      await worker.stop();
    }
    expect((await worker.stats()).deadLettered).toBe(1);
  });

  test('a stop waits out a telling still running before it closes the driver', async () => {
    spyOn(logger, 'error').mockImplementation(() => undefined);
    const row = await buriedRow();
    let closed = false;
    const driver: JobDriver = {
      ...row.driver,
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
    const worker = jobWorker({ driver, pollIntervalMs: 25, context, drainOnShutdown: false });
    worker.start();
    await time.until(row.entered);
    const stopping = worker.stop();
    await time.advance(5_000, 500);
    expect(closed).toBe(false);
    row.release();
    await stopping;
    expect(closed).toBe(true);
    expect((await worker.stats()).deadLettered).toBe(1);
  });
});
