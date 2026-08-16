// J7: there was no way to stop a runaway job. The internal cancellation was excellent — the
// deadline aborts, `steps.ts` fences every write — and nothing external could trigger it. The
// options were scaling the worker to zero (stopping EVERY job) or `UPDATE x_jobs` by hand, which
// the running worker's next ack silently overwrote because `SQL_ACK` had no state guard.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { createMemoryDriver } from './driver-memory';
import { SQL_ACK, SQL_CANCEL, SQL_NACK } from './driver-pg-sql';
import { cancelJob } from './inspect';
import { job, resetJobs } from './job';
import { createWorker } from './worker';

afterEach(() => {
  resetJobs();
});

function passthrough<T>(): StandardSchemaV1<unknown, T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'ultimate-test',
      validate: (value: unknown) => ({ value: value as T }),
    },
  };
}

const enqueue = (name: string) => ({
  name,
  queue: 'default',
  input: {},
  idempotencyKey: `${name}:one`,
  maxAttempts: 3,
});

describe('cancelling a job', () => {
  test('a RUNNING job that is cancelled is not un-cancelled by its own worker settling', async () => {
    // The bug this pins: `UPDATE x_jobs SET state='dead'` was the only recourse, and the worker's
    // next ack/nack wrote straight over it. Both settlements are now fenced on `running`.
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue(enqueue('runaway'));
    await driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 5000, workerId: 'w' });

    await driver.introspect?.cancel?.(id, 'wrong predicate, 40M rows');

    // The worker finishes and tries to say so. It must not resurrect the row.
    await driver.ack(id);
    expect((await driver.introspect?.job(id))?.state).toBe('cancelled');

    // Nor may a failure path.
    await driver.nack(id, { delayMs: 0, error: 'boom' });
    expect((await driver.introspect?.job(id))?.state).toBe('cancelled');
  });

  test('a cancelled job is never claimed again', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue(enqueue('runaway'));
    await driver.introspect?.cancel?.(id);

    const claimed = await driver.claim({
      queues: ['default'],
      limit: 10,
      visibilityTimeoutMs: 5000,
      workerId: 'w',
    });
    expect(claimed).toHaveLength(0);
  });

  test('cancel REFUSES rather than reporting a silent no-op', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue(enqueue('finished'));
    await driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 5000, workerId: 'w' });
    await driver.ack(id);

    // An operator cancelling a 40M-row sweep has to know whether they stopped it or missed it.
    await expect(cancelJob(driver, id)).rejects.toThrow(/"done"/);
    await expect(cancelJob(driver, 'no-such-job')).rejects.toThrow(/no job no-such-job/);
  });

  test('the heartbeat is what reaches a job that is already running', async () => {
    // The cancel writes a terminal state; the renewal that misses it is the signal. `false` from
    // `heartbeat` is the whole mechanism — before, it returned `void` and nothing could tell a
    // renewal that landed from one that matched no row.
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue(enqueue('runaway'));
    await driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 5000, workerId: 'w' });

    expect(await driver.heartbeat(id, { visibilityTimeoutMs: 5000, workerId: 'w' })).toBe(true);
    // A worker that is NOT the claimant never extends someone else's lease.
    expect(await driver.heartbeat(id, { visibilityTimeoutMs: 5000, workerId: 'other' })).toBe(
      false,
    );

    await driver.introspect?.cancel?.(id);
    expect(await driver.heartbeat(id, { visibilityTimeoutMs: 5000, workerId: 'w' })).toBe(false);
  });

  test('a cancelled attempt stops writing: the run belongs to nobody now', async () => {
    const driver = createMemoryDriver();
    let reachedSecondStep = false;
    job({
      tenant: 'none',
      name: 'runaway',
      input: passthrough<Record<string, never>>(),
      idempotencyKey: () => 'runaway:one',
      retry: { attempts: 1 },
      async run({ step, jobId }) {
        await step.run('batch:0', () => Promise.resolve(1));
        // Cancelled mid-run, exactly as `x jobs cancel` would. The next heartbeat aborts the
        // attempt and `steps.ts` refuses the write, which is what unwinds the body.
        await driver.introspect?.cancel?.(jobId);
        await Bun.sleep(15);
        await step.run('batch:1', () => {
          reachedSecondStep = true;
          return Promise.resolve(2);
        });
      },
    });
    await driver.enqueue(enqueue('runaway'));

    const worker = createWorker({
      driver,
      context: () => createContext({ role: 'worker' }),
      visibilityTimeoutMs: 5000,
      heartbeatIntervalMs: 5,
      drainOnShutdown: false,
    });
    const [execution] = await worker.tick();
    await worker.stop('test');

    // The body ran the second step's function but its RESULT was refused — the fence is the write.
    expect(reachedSecondStep).toBe(true);
    expect(execution?.outcome).not.toBe('completed');
    const steps = await driver.steps.list(
      (await driver.introspect?.job(execution?.jobId ?? ''))?.runId ?? '',
    );
    expect(steps.map((record) => record.name)).not.toContain('batch:1');
  });
});

describe('the cancel SQL', () => {
  test('every settlement is fenced on `running`, and cancel on "not done"', () => {
    expect(SQL_ACK).toContain("where id = $1 and state = 'running'");
    expect(SQL_NACK).toContain("where id = $1 and state = 'running'");
    expect(SQL_CANCEL).toContain("where id = $1 and state <> 'done'");
    expect(SQL_CANCEL).toContain("set state = 'cancelled'");
    // Returns the row, so the caller can tell "cancelled it" from "there was nothing to cancel".
    expect(SQL_CANCEL).toContain('returning *');
  });
});
