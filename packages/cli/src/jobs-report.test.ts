// Flag parsing plus ls / show / retry, driven through `createMemoryDriver()` — a real driver with
// real introspection and claim/ack/nack, so a dead letter here reached `dead` the way a pg queue
// would. Drain has its own suite next to `jobs-drain.ts`.

import { describe, expect, test } from 'bun:test';
import type { JobDriver, StepRecord } from '@ultimat3/jobs';
import { createMemoryDriver } from '@ultimat3/jobs';
import { BadFlagError, JobUnknownError } from './errors';
import {
  JOB_STATES,
  listJobs,
  parseLimitFlag,
  parseStateFlag,
  retryJob,
  showJob,
} from './jobs-report';

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
    workerId: 'w',
  });
  await driver.nack(id, { delayMs: 0, deadLetter: true, error: 'boom' });
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

describe('unit · jobs flag parsing', () => {
  test('every JobState the drivers can report is accepted', () => {
    for (const state of JOB_STATES) expect(parseStateFlag(state)).toBe(state);
    expect(parseStateFlag(undefined)).toBeUndefined();
  });

  test('an unknown --state throws X_CLI_BAD_FLAG naming the known states', () => {
    expect(() => parseStateFlag('exploded')).toThrow(BadFlagError);
  });

  test('a positive integer --limit parses, with surrounding space tolerated', () => {
    expect(parseLimitFlag('25')).toBe(25);
    expect(parseLimitFlag('  7  ')).toBe(7);
    expect(parseLimitFlag(undefined)).toBeUndefined();
  });

  test('a --limit above Number.MAX_SAFE_INTEGER is rejected, not silently rounded', () => {
    const unsafe = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    // The bug this guards: the parse lands on a different integer than the one that was typed.
    expect(BigInt(Number(unsafe))).not.toBe(BigInt(unsafe));
    expect(() => parseLimitFlag(unsafe)).toThrow(BadFlagError);
    expect(() => parseLimitFlag('99999999999999999999')).toThrow(BadFlagError);
  });

  test('a non-integer, non-positive or non-numeric --limit throws X_CLI_BAD_FLAG', () => {
    for (const value of ['3.5', '0', '-2', 'abc', '1e400', '', '0x10']) {
      expect(() => parseLimitFlag(value)).toThrow(BadFlagError);
    }
  });
});

describe('unit · listJobs', () => {
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
    expect(result.deadLetters[0]?.retryCommand).toBe(`x jobs retry ${deadId}`);
  });

  test('--state, --queue and --limit each narrow the row list', async () => {
    const driver = createMemoryDriver();
    const aId = await enqueue(driver, { queue: 'queue-a' });
    await enqueue(driver, { queue: 'queue-b' });
    const deadId = await makeDeadJob(driver, 'dead-job');

    expect((await listJobs(driver, { queue: 'queue-a' })).rows.map((row) => row.id)).toEqual([aId]);
    expect((await listJobs(driver, { state: 'dead' })).rows.map((row) => row.id)).toEqual([deadId]);
    expect((await listJobs(driver, { limit: '2' })).rows).toHaveLength(2);
  });

  test('a rejected flag surfaces before any driver call', async () => {
    const driver = createMemoryDriver();
    await expect(listJobs(driver, { state: 'exploded' })).rejects.toThrow(BadFlagError);
    await expect(listJobs(driver, { limit: '3.5' })).rejects.toThrow(BadFlagError);
  });

  test('only the backfills still sweeping come back — a finished one is history', async () => {
    const driver = createMemoryDriver();
    for (const runId of ['run_live', 'run_old']) {
      await driver.backfills?.start({
        runId,
        name: `pass-${runId}`,
        checksum: 'abc123',
        appVersion: '1.2.0',
      });
    }
    await driver.backfills?.progress('run_live', { rows: 42, cursor: 'post_42' });
    await driver.backfills?.finish('run_old', { status: 'completed', rows: 900 });

    const result = await listJobs(driver);

    expect(result.backfills.map((pass) => pass.runId)).toEqual(['run_live']);
    expect(result.backfills[0]).toMatchObject({ rows: 42, cursor: 'post_42', status: 'running' });
  });

  test('a queue with no ledger rows reports no backfills rather than failing', async () => {
    expect((await listJobs(createMemoryDriver())).backfills).toEqual([]);
  });
});

describe('unit · showJob and retryJob', () => {
  test('showJob returns the full trace for a known job', async () => {
    const driver = createMemoryDriver();
    const id = await enqueue(driver, { name: 'send-email' });
    const trace = await showJob(driver, id);
    expect(trace).toMatchObject({ id, name: 'send-email', state: 'ready', attempt: 0, steps: [] });
  });

  test('retryJob puts a dead job back to ready', async () => {
    const driver = createMemoryDriver();
    const id = await makeDeadJob(driver);
    expect((await showJob(driver, id)).state).toBe('dead');
    expect(await retryJob(driver, id)).toMatchObject({ state: 'ready', attempt: 0 });
  });

  test('--from-step drops that step so it re-executes, keeping the others', async () => {
    const driver = createMemoryDriver();
    const id = await makeDeadJob(driver);
    const { runId } = await showJob(driver, id);
    await driver.steps.put(completedStep(runId, 'charge-card'));
    await driver.steps.put(completedStep(runId, 'send-receipt'));

    await retryJob(driver, id, 'send-receipt');

    expect((await driver.steps.list(runId)).map((step) => step.name)).toEqual(['charge-card']);
  });

  test('an unknown id throws X_JOB_UNKNOWN from both commands', async () => {
    const driver = createMemoryDriver();
    await expect(showJob(driver, 'no-such-id')).rejects.toThrow(JobUnknownError);
    await expect(retryJob(driver, 'no-such-id')).rejects.toThrow(JobUnknownError);
  });
});
