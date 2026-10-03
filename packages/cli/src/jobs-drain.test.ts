// The drain's two data-integrity rules, exercised against `createMemoryDriver()` — a real driver
// with real claim/ack/nack and the same `runAt` visibility rule a pg queue enforces. A mock that
// always granted a lease would assert nothing: not leasing is exactly the case that must be safe.

import { describe, expect, test } from 'bun:test';
import type { JobDriver, StepRecord } from '@ultimat3/jobs';
import { createMemoryDriver, createRedisDriver } from '@ultimat3/jobs';
import { CliNotImplementedError } from './errors';
import { drainJobs } from './jobs-drain';
import { listJobs } from './jobs-report';

async function enqueue(
  driver: JobDriver,
  name: string,
  runAt?: number,
  queue = 'default',
): Promise<string> {
  const { id } = await driver.enqueue({
    name,
    queue,
    input: { hello: 'world' },
    idempotencyKey: crypto.randomUUID(),
    maxAttempts: 3,
    ...(runAt === undefined ? {} : { runAt }),
  });
  return id;
}

/**
 * Claim then nack with `countsAsAttempt: false` — a suspension, not a failed attempt. `delayMs`
 * is 0 so the parked run is claimable again immediately: a drain moves only what it can lease.
 * Its own queue, so this setup claim cannot sweep up whatever else the test already enqueued.
 */
async function makeSuspendedJob(driver: JobDriver, name: string): Promise<string> {
  const id = await enqueue(driver, name, undefined, 'susp-only');
  await driver.claim({
    queues: ['susp-only'],
    limit: 10,
    visibilityTimeoutMs: 60_000,
    workerId: 'w',
  });
  await driver.nack(id, { workerId: 'w', claim: 1, delayMs: 0, countsAsAttempt: false });
  return id;
}

const completedStep = (runId: string, name: string): StepRecord => ({
  runId,
  name,
  status: 'completed',
  output: { charged: true },
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_001_000,
  attempts: 1,
});

const runIdOf = async (driver: JobDriver, id: string): Promise<string> =>
  (await driver.introspect?.job(id))?.runId ?? '';

/** A source that never grants a lease, and remembers every id the drain tried to acknowledge. */
function leaselessSource(inner: JobDriver): { driver: JobDriver; acked: string[] } {
  const acked: string[] = [];
  return {
    acked,
    driver: {
      ...inner,
      claim: () => Promise.resolve([]),
      ack: (id: string) => {
        acked.push(id);
        return inner.ack(id, { workerId: 'w', claim: 1 });
      },
    },
  };
}

describe('unit · drainJobs ownership', () => {
  test('moves every job it can lease and marks the source copy done', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const readyId = await enqueue(source, 'ready-job');
    const suspendedId = await makeSuspendedJob(source, 'suspended-job');

    const outcome = await drainJobs(source, target, false);

    expect(outcome.failures).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.moved.map((record) => record.id).sort()).toEqual([readyId, suspendedId].sort());
    // The rows are reported as the drain found them, not mid-lease as `claim()` returns them.
    expect(outcome.moved.map((record) => record.state).sort()).toEqual(['ready', 'ready']);
    expect((await source.introspect?.job(readyId))?.state).toBe('done');
    expect((await listJobs(target)).rows).toHaveLength(2);
  });

  // The source row is settled `done` because it LEFT. Until 2026-10-01 that ack went through
  // the same counter every completed run does, so draining 10,000 queued jobs put 10,000 runs in
  // the source's history for work that had not started.
  test('a moved job adds nothing to the source`s counters — it was moved, not run', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const id = await enqueue(source, 'ready-job');

    const outcome = await drainJobs(source, target, false);

    expect(outcome.moved.map((record) => record.id)).toEqual([id]);
    expect((await source.introspect?.job(id))?.state).toBe('done');
    expect(await source.introspect?.counterTotals(0)).toEqual([]);
  });

  test('never acknowledges a candidate it could not lease', async () => {
    const inner = createMemoryDriver();
    const target = createMemoryDriver();
    const id = await enqueue(inner, 'ready-job');
    const { driver: source, acked } = leaselessSource(inner);

    const outcome = await drainJobs(source, target, false);

    // The bug this guards: a source worker claims the row between the snapshot and the ack, so
    // the target runs a duplicate of a job that is still executing. No lease, no ack, ever.
    expect(acked).toEqual([]);
    expect(outcome.moved).toEqual([]);
    expect(outcome.candidates.map((record) => record.id)).toEqual([id]);
    expect(outcome.skipped.map((skip) => skip.id)).toEqual([id]);
    expect(outcome.skipped[0]?.reason).toContain('no lease');
    expect((await inner.introspect?.job(id))?.state).toBe('ready');
    expect((await listJobs(target)).rows).toEqual([]);
  });

  test('a job that is not yet due is skipped, because no driver leases it before runAt', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const delayedId = await enqueue(source, 'delayed-job', Date.now() + 60_000);

    const outcome = await drainJobs(source, target, false);

    expect(outcome.moved).toEqual([]);
    expect(outcome.skipped.map((skip) => skip.state)).toEqual(['delayed']);
    expect((await source.introspect?.job(delayedId))?.state).toBe('delayed');
    expect((await listJobs(target)).rows).toEqual([]);
  });

  test('--dry-run reports the plan, takes no lease and moves nothing', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const readyId = await enqueue(source, 'ready-job');
    await enqueue(source, 'delayed-job', Date.now() + 60_000);

    const outcome = await drainJobs(source, target, true);

    expect(outcome.dryRun).toBe(true);
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.moved).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.failures).toEqual([]);
    // A lease would have moved it to `running`; a dry run leaves the queue exactly as it was.
    expect((await source.introspect?.job(readyId))?.state).toBe('ready');
    expect((await listJobs(target)).rows).toEqual([]);
  });

  test('a record that cannot enqueue on the target is reported and its lease is released', async () => {
    const source = createMemoryDriver();
    const target = createRedisDriver(); // honest X_NOT_IMPLEMENTED stub — enqueue always throws
    const id = await enqueue(source, 'ready-job');

    const outcome = await drainJobs(source, target, false);

    expect(outcome.moved).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.finding.code).toBe('X_NOT_IMPLEMENTED');

    // The lease went back with no attempt burned, so the job is claimable and the drain is
    // retryable — the one thing a half-finished transfer must never cost is a retry budget.
    const after = await source.introspect?.job(id);
    expect(after?.attempt).toBe(0);
    expect(after?.state).toBe('ready');
    const reclaimed = await source.claim({
      queues: ['default'],
      limit: 5,
      visibilityTimeoutMs: 1000,
      workerId: 'w',
    });
    expect(reclaimed.map((record) => record.id)).toEqual([id]);
  });
});

describe('unit · drainJobs step transfer', () => {
  test('a suspended run arrives on the target with its persisted steps intact', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const id = await makeSuspendedJob(source, 'checkout');
    const runId = await runIdOf(source, id);
    await source.steps.put(completedStep(runId, 'charge-card'));
    await source.steps.put({ ...completedStep(runId, 'await-webhook'), status: 'sleeping' });

    const outcome = await drainJobs(source, target, false);

    expect(outcome.moved).toHaveLength(1);
    // Without this the resumed run repeats `charge-card`, or loses its checkpoint outright.
    expect((await listJobs(target)).rows[0]?.runId).toBe(runId);
    const steps = await target.steps.list(runId);
    expect(steps.map((step) => step.name)).toEqual(['charge-card', 'await-webhook']);
    expect(steps[0]).toEqual(completedStep(runId, 'charge-card'));
    expect(steps[1]?.status).toBe('sleeping');
  });

  test('a candidate left behind keeps its steps on the source, untouched', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const id = await enqueue(source, 'delayed-job', Date.now() + 60_000);
    const runId = await runIdOf(source, id);
    await source.steps.put(completedStep(runId, 'charge-card'));

    await drainJobs(source, target, false);

    expect(await target.steps.list(runId)).toEqual([]);
    expect((await source.steps.list(runId)).map((step) => step.name)).toEqual(['charge-card']);
  });

  test('a run with no steps still transfers, and the source is acknowledged last', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const id = await enqueue(source, 'ready-job');
    const runId = await runIdOf(source, id);

    await drainJobs(source, target, false);

    expect(await target.steps.list(runId)).toEqual([]);
    expect((await source.introspect?.job(id))?.state).toBe('done');
    expect((await listJobs(target)).rows[0]?.runId).toBe(runId);
  });
});

// The list behind the drain answered one default page (100 rows) per state: 350 ready jobs moved
// 100, the summary said "100 left", and 250 stayed on a source the operator was retiring.
describe('unit · the drain walks every page', () => {
  test('350 ready jobs on the source are 350 candidates, 350 moved, none left', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    for (let index = 0; index < 350; index += 1) await enqueue(source, `bulk-${index}`);

    const planned = await drainJobs(source, target, true);
    expect(planned.candidates).toHaveLength(350);
    expect(new Set(planned.candidates.map((record) => record.id)).size).toBe(350);

    const outcome = await drainJobs(source, target, false);
    expect(outcome.moved).toHaveLength(350);
    expect(outcome.skipped).toEqual([]);
    expect((await listJobs(source, { state: 'ready' })).rows).toEqual([]);
    expect((await target.stats()).reduce((sum, row) => sum + row.ready, 0)).toBe(350);
  }, 30_000);
});

// A batch that moved SOME rows released the ones the target refused, and the next batch could
// lease them again: the refused id landed in `failures` twice and spent budget a real candidate
// was owed. A refused id is tried once per drain.
describe('unit · a refused row is tried once', () => {
  test('a partly refused batch never re-leases the refused id', async () => {
    const source = createMemoryDriver();
    const inner = createMemoryDriver();
    const target: JobDriver = {
      ...inner,
      enqueue: (request) =>
        request.name === 'bad'
          ? Promise.reject(
              new CliNotImplementedError({ feature: 'the bad job', fix: 'x jobs ls --json' }),
            )
          : inner.enqueue(request),
    };
    // Unclaimable, so the budget outlives the claimable rows — the shape that re-leased.
    await enqueue(source, 'later', Date.now() + 3_600_000);
    const bad = await enqueue(source, 'bad');
    await enqueue(source, 'good');

    const outcome = await drainJobs(source, target, false);

    expect(outcome.failures.map((failure) => failure.id)).toEqual([bad]);
    expect(outcome.moved.map((record) => record.name)).toEqual(['good']);
    expect(outcome.skipped.map((skip) => skip.name)).toEqual(['later']);
    expect((await source.introspect?.job(bad))?.state).toBe('ready');
  });
});
