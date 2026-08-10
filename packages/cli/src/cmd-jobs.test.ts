// `x jobs` drives every path through `createMemoryDriver()` — a real driver with real
// introspection, claim/ack/nack semantics included, but no database and no boot. That is what
// lets this suite assert dead-letter and drain behaviour without an app on disk.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { createMemoryDriver, createRedisDriver } from '@ultimat3/jobs';
import {
  buildDrainTarget,
  drainJobs,
  JOBS_SUBCOMMANDS,
  jobsCommand,
  listJobs,
  retryJob,
  showJob,
} from './cmd-jobs';
import { BadFlagError, JobUnknownError } from './errors';
import { renderJobTable } from './jobs-report';

interface EnqueueOverrides {
  readonly name?: string;
  readonly queue?: string;
  readonly runAt?: number;
}

async function enqueue(driver: JobDriver, overrides: EnqueueOverrides = {}): Promise<string> {
  const { id } = await driver.enqueue({
    name: overrides.name ?? 'send-email',
    queue: overrides.queue ?? 'default',
    input: { hello: 'world' },
    idempotencyKey: crypto.randomUUID(),
    maxAttempts: 3,
    ...(overrides.runAt === undefined ? {} : { runAt: overrides.runAt }),
  });
  return id;
}

/** Claim then nack with `deadLetter: true` — the only honest way any driver reaches `dead`. */
async function makeDeadJob(driver: JobDriver, name = 'send-email'): Promise<string> {
  const id = await enqueue(driver, { name, queue: 'dead-only' });
  await driver.claim({
    queues: ['dead-only'],
    limit: 10,
    visibilityTimeoutMs: 60_000,
    workerId: 'w1',
  });
  await driver.nack(id, { delayMs: 0, deadLetter: true, error: 'boom' });
  return id;
}

/** Claim then nack with `countsAsAttempt: false` — a suspension, not a failed attempt. */
async function makeSuspendedJob(driver: JobDriver, name = 'send-email'): Promise<string> {
  const id = await enqueue(driver, { name, queue: 'susp-only' });
  await driver.claim({
    queues: ['susp-only'],
    limit: 10,
    visibilityTimeoutMs: 60_000,
    workerId: 'w1',
  });
  await driver.nack(id, { delayMs: 1000, countsAsAttempt: false });
  return id;
}

describe('unit · x jobs spec', () => {
  test('names all four subcommands, ls first, with every documented flag', () => {
    expect(JOBS_SUBCOMMANDS).toEqual(['ls', 'show', 'retry', 'drain']);
    expect(jobsCommand.spec.subcommands).toBe(JOBS_SUBCOMMANDS);
    expect(jobsCommand.spec.name).toBe('jobs');
    expect(jobsCommand.spec.requiresApp).toBe(true);
    expect(jobsCommand.spec.flags?.map((flag) => flag.name).sort()).toEqual(
      ['dry-run', 'from-step', 'limit', 'name', 'queue', 'state', 'to'].sort(),
    );
  });
});

describe('unit · x jobs ls', () => {
  test('an empty queue reports zero everywhere', async () => {
    const driver = createMemoryDriver();
    const result = await listJobs(driver);
    expect(result.rows).toEqual([]);
    expect(result.deadLetters).toEqual([]);
    expect(result.depth.totals).toEqual({
      ready: 0,
      delayed: 0,
      running: 0,
      suspended: 0,
      dead: 0,
    });
  });

  test('ready, delayed and dead jobs are all counted and listed', async () => {
    const driver = createMemoryDriver();
    const readyId = await enqueue(driver, { name: 'ready-job' });
    const delayedId = await enqueue(driver, { name: 'delayed-job', runAt: Date.now() + 60_000 });
    const deadId = await makeDeadJob(driver, 'dead-job');

    const result = await listJobs(driver);
    expect(result.depth.totals).toEqual({
      ready: 1,
      delayed: 1,
      running: 0,
      suspended: 0,
      dead: 1,
    });
    expect(result.rows.map((row) => row.id).sort()).toEqual([readyId, delayedId, deadId].sort());
    expect(result.deadLetters).toHaveLength(1);
    expect(result.deadLetters[0]?.id).toBe(deadId);
    expect(result.deadLetters[0]?.retryCommand).toBe(`x jobs retry ${deadId}`);
  });

  test('--state filters the row list', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, { name: 'ready-job' });
    const deadId = await makeDeadJob(driver, 'dead-job');

    const result = await listJobs(driver, { state: 'dead' });
    expect(result.rows.map((row) => row.id)).toEqual([deadId]);
  });

  test('--queue filters the row list', async () => {
    const driver = createMemoryDriver();
    const aId = await enqueue(driver, { queue: 'queue-a' });
    await enqueue(driver, { queue: 'queue-b' });

    const result = await listJobs(driver, { queue: 'queue-a' });
    expect(result.rows.map((row) => row.id)).toEqual([aId]);
  });

  test('--limit caps the row list', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver);
    await enqueue(driver);
    await enqueue(driver);

    const result = await listJobs(driver, { limit: '2' });
    expect(result.rows).toHaveLength(2);
  });

  test('an unknown --state throws X_CLI_BAD_FLAG', async () => {
    const driver = createMemoryDriver();
    await expect(listJobs(driver, { state: 'exploded' })).rejects.toThrow(BadFlagError);
  });

  test('a non-integer or non-positive --limit throws X_CLI_BAD_FLAG', async () => {
    const driver = createMemoryDriver();
    await expect(listJobs(driver, { limit: '3.5' })).rejects.toThrow(BadFlagError);
    await expect(listJobs(driver, { limit: '0' })).rejects.toThrow(BadFlagError);
    await expect(listJobs(driver, { limit: 'abc' })).rejects.toThrow(BadFlagError);
  });
});

describe('unit · x jobs show', () => {
  test('returns the full trace for a known job', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, { name: 'send-email' });

    const trace = await showJob(driver, id);
    expect(trace.id).toBe(id);
    expect(trace.name).toBe('send-email');
    expect(trace.state).toBe('ready');
    expect(trace.attempt).toBe(0);
    expect(trace.steps).toEqual([]);
  });

  test('an unknown id throws X_JOB_UNKNOWN', async () => {
    const driver = createMemoryDriver();
    await expect(showJob(driver, 'no-such-id')).rejects.toThrow(JobUnknownError);
  });
});

describe('unit · x jobs retry', () => {
  test('puts a dead job back to ready', async () => {
    const driver = createMemoryDriver();
    const id = await makeDeadJob(driver);
    expect((await showJob(driver, id)).state).toBe('dead');

    const retried = await retryJob(driver, id);
    expect(retried.state).toBe('ready');
    expect(retried.attempt).toBe(0);
  });

  test('--from-step drops that step so it re-executes, keeping the others', async () => {
    const driver = createMemoryDriver();
    const id = await makeDeadJob(driver);
    const { runId } = await showJob(driver, id);
    await driver.steps.put({
      runId,
      name: 'charge-card',
      status: 'completed',
      output: { ok: true },
      startedAt: Date.now(),
      completedAt: Date.now(),
      attempts: 1,
    });
    await driver.steps.put({
      runId,
      name: 'send-receipt',
      status: 'completed',
      output: null,
      startedAt: Date.now(),
      completedAt: Date.now(),
      attempts: 1,
    });

    await retryJob(driver, id, 'send-receipt');

    const steps = await driver.steps.list(runId);
    expect(steps.map((step) => step.name)).toEqual(['charge-card']);
  });

  test('an unknown id throws X_JOB_UNKNOWN', async () => {
    const driver = createMemoryDriver();
    await expect(retryJob(driver, 'no-such-id')).rejects.toThrow(JobUnknownError);
  });
});

describe('unit · x jobs drain', () => {
  test('moves every pending job onto the target and leaves none pending on the source', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    const readyId = await enqueue(source, { name: 'ready-job' });
    const delayedId = await enqueue(source, { name: 'delayed-job', runAt: Date.now() + 60_000 });
    const suspendedId = await makeSuspendedJob(source, 'suspended-job');

    const outcome = await drainJobs(source, target, false);

    expect(outcome.failures).toEqual([]);
    expect(outcome.moved.map((record) => record.id).sort()).toEqual(
      [readyId, delayedId, suspendedId].sort(),
    );

    const sourceAfter = await listJobs(source);
    const pendingStates: readonly string[] = ['ready', 'delayed', 'suspended'];
    expect(sourceAfter.rows.filter((row) => pendingStates.includes(row.state))).toEqual([]);

    const targetAfter = await listJobs(target);
    expect(targetAfter.rows).toHaveLength(3);
    expect(targetAfter.rows.map((row) => row.idempotencyKey).sort()).toEqual(
      outcome.moved.map((record) => record.idempotencyKey).sort(),
    );
  });

  test('--dry-run reports the plan and moves nothing', async () => {
    const source = createMemoryDriver();
    const target = createMemoryDriver();
    await enqueue(source, { name: 'ready-job' });
    await enqueue(source, { name: 'delayed-job', runAt: Date.now() + 60_000 });

    const outcome = await drainJobs(source, target, true);

    expect(outcome.dryRun).toBe(true);
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.moved).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect((await listJobs(target)).rows).toEqual([]);
  });

  test('a record that cannot enqueue on the target is reported as a failure, not thrown', async () => {
    const source = createMemoryDriver();
    const target = createRedisDriver(); // honest X_NOT_IMPLEMENTED stub — enqueue always throws
    await enqueue(source, { name: 'ready-job' });

    const outcome = await drainJobs(source, target, false);

    expect(outcome.moved).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.finding.code).toBe('X_NOT_IMPLEMENTED');

    // Nothing was ack'd: the job is exactly where it was, ready for the drain to be retried.
    const sourceAfter = await listJobs(source);
    expect(sourceAfter.rows[0]?.state).toBe('ready');
  });
});

describe('unit · x jobs drain target', () => {
  test('an unknown --to value throws X_CLI_BAD_FLAG naming the accepted values', () => {
    expect(() => buildDrainTarget('sqs', {})).toThrow(BadFlagError);
  });

  test('a missing --to value throws X_CLI_BAD_FLAG', () => {
    expect(() => buildDrainTarget(undefined, {})).toThrow(BadFlagError);
  });

  test('--to memory needs no environment variable', () => {
    expect(buildDrainTarget('memory', {}).name).toBe('memory');
  });

  test('--to redis without REDIS_URL throws X_CLI_BAD_FLAG', () => {
    expect(() => buildDrainTarget('redis', {})).toThrow(BadFlagError);
  });

  test('--to redis with REDIS_URL builds a redis driver', () => {
    expect(buildDrainTarget('redis', { REDIS_URL: 'redis://localhost:6379' }).name).toBe('redis');
  });

  test('--to nats without NATS_URL throws X_CLI_BAD_FLAG', () => {
    expect(() => buildDrainTarget('nats', {})).toThrow(BadFlagError);
  });

  test('--to nats with NATS_URL builds a nats driver', () => {
    expect(buildDrainTarget('nats', { NATS_URL: 'nats://localhost:4222' }).name).toBe('nats');
  });
});

describe('unit · x jobs table', () => {
  test('renderJobTable pads every line to the same fixed width', async () => {
    const driver = createMemoryDriver();
    await enqueue(driver, { name: 'short' });
    await enqueue(driver, { name: 'a-much-longer-job-name-than-the-others' });

    const result = await listJobs(driver);
    const lines = renderJobTable(result.rows);

    expect(lines).toHaveLength(3); // header + 2 rows
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
    expect(lines[0]?.startsWith('id')).toBe(true);
  });
});
