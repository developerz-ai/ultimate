// `requeue` — `x jobs retry` — on both drivers. It re-armed ANY row: a RUNNING job came back
// `ready` with `claimed_by` still set, so a second worker claimed it and it ran twice; and a `done`
// job whose idempotency key a live job now holds raised a raw 23505 on pg while memory accepted it
// and ended with two live rows for one key. `fromStep` dropped only the named step, although the
// contract says "from that step onward", so later steps replayed results from the old run.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_JOB_REQUEUE } from './driver-pg-jobs-sql';

/** One attempt; `nack(…, { deadLetter: true })` puts it where `x jobs retry` exists for. */
const enqueue = (driver: JobDriver, key: string) =>
  driver.enqueue({
    name: 'sync',
    queue: 'default',
    input: {},
    idempotencyKey: key,
    maxAttempts: 1,
  });

const claimOne = (driver: JobDriver) =>
  driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' });

const codeOf = async (work: Promise<unknown>): Promise<string | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );

describe('memory: requeue takes a finished job and nothing else', () => {
  test('a RUNNING job is refused, and keeps its claim', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueue(driver, 'sync:1');
    await claimOne(driver);
    expect(await codeOf(driver.introspect?.requeue(id) ?? Promise.resolve())).toBe(
      'X_JOB_NOT_REQUEUEABLE',
    );
    const after = await driver.introspect?.job(id);
    expect(after?.state).toBe('running');
    expect(after?.claimedBy).toBe('w1');
  });

  test('a done job whose key a live job now holds is X_JOB_DUPLICATE, never a second live row', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueue(driver, 'sync:1');
    await claimOne(driver);
    await driver.ack(id);
    await enqueue(driver, 'sync:1');
    expect(await codeOf(driver.introspect?.requeue(id) ?? Promise.resolve())).toBe(
      'X_JOB_DUPLICATE',
    );
    expect((await driver.introspect?.job(id))?.state).toBe('done');
  });

  test('a dead job comes back ready at attempt 0, unclaimed', async () => {
    const driver = createMemoryDriver();
    const { id } = await enqueue(driver, 'sync:1');
    await claimOne(driver);
    await driver.nack(id, { delayMs: 0, deadLetter: true });
    const back = await driver.introspect?.requeue(id);
    expect(back?.state).toBe('ready');
    expect(back?.attempt).toBe(0);
    expect(back?.claimedBy).toBeUndefined();
  });
});

describe('memory: fromStep drops that step AND every step after it', () => {
  test('earlier steps stay memoized, the target and later ones are gone', async () => {
    const clock = frozenClock('2026-01-01T00:00:00.000Z');
    const driver = createMemoryDriver({ clock });
    const { id, runId } = await enqueue(driver, 'sync:1');
    await claimOne(driver);
    const steps = driver.steps;
    for (const [index, name] of ['fetch', 'charge', 'email'].entries()) {
      await steps.put({
        runId,
        name,
        status: 'completed',
        output: index,
        startedAt: index,
        attempts: 1,
      });
    }
    await driver.nack(id, { delayMs: 0, deadLetter: true });
    await driver.introspect?.requeue(id, { fromStep: 'charge' });
    expect((await steps.list(runId)).map((record) => record.name)).toEqual(['fetch']);
  });

  // A step sharing the target's millisecond is not provably later, and re-running an EARLIER one —
  // the charge before the receipt — is the worse mistake, so a tie is kept.
  test('a step that started in the same millisecond as the target is kept', async () => {
    const driver = createMemoryDriver();
    const { id, runId } = await enqueue(driver, 'sync:2');
    await claimOne(driver);
    for (const name of ['charge', 'receipt']) {
      await driver.steps.put({
        runId,
        name,
        status: 'completed',
        output: 1,
        startedAt: 7,
        attempts: 1,
      });
    }
    await driver.nack(id, { delayMs: 0, deadLetter: true });
    await driver.introspect?.requeue(id, { fromStep: 'receipt' });
    expect((await driver.steps.list(runId)).map((record) => record.name)).toEqual(['charge']);
  });
});

describe('pg: the same two refusals, before the statement', () => {
  function executorAnswering(state: string, holder: readonly { id: string }[] = []) {
    const sql: string[] = [];
    const executor: PgExecutor = {
      query<R>(text: string): Promise<readonly R[]> {
        sql.push(text);
        if (text.includes('where id = $1') && text.trim().startsWith('select')) {
          return Promise.resolve([
            {
              id: 'job-1',
              name: 'sync',
              queue: 'default',
              input: {},
              idempotency_key: 'sync:1',
              run_id: 'run-1',
              attempt: 1,
              max_attempts: 3,
              state,
              tenant_id: null,
              last_error: null,
              claimed_by: state === 'running' ? 'w1' : null,
              traceparent: null,
              enqueued_by: null,
              run_at: '0',
              visible_at: null,
              created_at: '0',
              updated_at: '0',
            },
          ] as unknown as readonly R[]);
        }
        if (text.includes('idempotency_key = $3'))
          return Promise.resolve(holder as unknown as readonly R[]);
        return Promise.resolve([] as readonly R[]);
      },
    };
    return { executor, sql };
  }

  const pg = (executor: PgExecutor) => createPgDriver({ executor });

  test('a running row is refused and no update is sent', async () => {
    const { executor, sql } = executorAnswering('running');
    expect(await codeOf(pg(executor).introspect?.requeue('job-1') ?? Promise.resolve())).toBe(
      'X_JOB_NOT_REQUEUEABLE',
    );
    expect(sql.some((text) => text.startsWith('update x_jobs'))).toBe(false);
  });

  test('a key a live row holds is X_JOB_DUPLICATE, not a raw 23505', async () => {
    const { executor } = executorAnswering('done', [{ id: 'job-2' }]);
    expect(await codeOf(pg(executor).introspect?.requeue('job-1') ?? Promise.resolve())).toBe(
      'X_JOB_DUPLICATE',
    );
  });

  test('the update is fenced to finished states and releases the claim', () => {
    expect(SQL_JOB_REQUEUE).toContain("state in ('dead', 'cancelled', 'done', 'failed')");
    expect(SQL_JOB_REQUEUE).toContain('claimed_by = null');
  });
});
