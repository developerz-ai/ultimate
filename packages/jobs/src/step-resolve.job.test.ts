// `resolveStep` and the two new step statuses, on BOTH drivers: memory and a real Postgres answer
// the same scenario identically — `started` and `cleared` round-trip, a running job and a step with
// no unknown outcome are `X_STEP_NOT_RESOLVABLE`, an unknown id `X_JOB_NOT_FOUND`. Opt-in (`.job.`).

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError, uuidV7 } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { claimOf } from './driver';
import { memoryJobDriver } from './driver-memory';
import { postgresJobDriver } from './driver-pg';
import { embeddedPg } from './embedded-pg-fixture';

afterAll(async () => {
  await (await embeddedPg()).close();
});

const codeOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'resolved',
    (error: unknown) => (isUltimateError(error) ? error.code : error),
  );

const DRIVERS: readonly (readonly [string, () => Promise<JobDriver>])[] = [
  ['memory', () => Promise.resolve(memoryJobDriver())],
  [
    'pg',
    async () => {
      const pg = await embeddedPg();
      await pg.reset();
      return postgresJobDriver({ executor: pg.executor });
    },
  ],
];

describe.each(DRIVERS)('resolveStep on the %s driver', (_label, make) => {
  test('one scenario, one set of answers', async () => {
    const driver = await make();
    const operator = driver.introspect;
    const resolve = operator?.resolveStep?.bind(operator);
    if (operator === undefined || resolve === undefined) {
      return expect.unreachable('the driver has no resolveStep');
    }
    const { id } = await driver.enqueue({
      name: 'payout',
      queue: 'default',
      input: {},
      idempotencyKey: 'payout:1',
      maxAttempts: 1,
    });
    const [held] = await driver.claim({
      queues: ['default'],
      limit: 1,
      visibilityTimeoutMs: 30_000,
      workerId: 'w-1',
    });
    if (held === undefined) return expect.unreachable('nothing was claimed');
    const fence = { job: 'payout', jobId: id, ...claimOf(held) };
    await driver.steps.put(
      { runId: held.runId, name: 'send', status: 'started', startedAt: 1_000, attempts: 0 },
      fence,
    );
    await driver.steps.put(
      { runId: held.runId, name: 'notify', status: 'failed', startedAt: 2_000, attempts: 1 },
      fence,
    );
    await driver.steps.put(
      {
        runId: held.runId,
        name: 'draft',
        status: 'completed',
        output: 1,
        startedAt: 500,
        attempts: 1,
      },
      fence,
    );
    expect((await driver.steps.get(held.runId, 'send'))?.status).toBe('started');

    // A worker holds it: whatever the step says, no one may answer for it yet.
    expect(await codeOf(resolve(id, 'send', { ran: false }))).toBe('X_STEP_NOT_RESOLVABLE');
    await driver.nack(id, {
      ...claimOf(held),
      delayMs: 0,
      countsAsAttempt: true,
      deadLetter: true,
    });

    expect(await codeOf(resolve(uuidV7(), 'send', { ran: false }))).toBe('X_JOB_NOT_FOUND');
    expect(await codeOf(resolve(id, 'nosuch', { ran: false }))).toBe('X_STEP_NOT_RESOLVABLE');
    expect(await codeOf(resolve(id, 'draft', { ran: false }))).toBe('X_STEP_NOT_RESOLVABLE');

    const ran = await resolve(id, 'send', { ran: true, output: { receipt: 'r-1' } });
    expect(ran).toMatchObject({ name: 'send', status: 'completed', output: { receipt: 'r-1' } });
    expect(await codeOf(resolve(id, 'send', { ran: false }))).toBe('X_STEP_NOT_RESOLVABLE');

    const cleared = await resolve(id, 'notify', { ran: false });
    expect(cleared).toMatchObject({ name: 'notify', status: 'cleared' });
    expect(cleared.error).toBeUndefined();

    const statuses = Object.fromEntries(
      (await driver.steps.list(held.runId)).map((step) => [step.name, step.status]),
    );
    expect(statuses).toEqual({ draft: 'completed', send: 'completed', notify: 'cleared' });
  });
});
