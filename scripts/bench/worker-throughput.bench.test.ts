// The worker bench's process-free halves: one pod's worker draining no-op jobs off the memory
// driver (the same `workerPod` the spawned child runs over Postgres), the `ready` handshake its
// harness reads, and the flags and report around them.

import { afterEach, describe, expect, test } from 'bun:test';
import { memoryJobDriver } from '../../packages/jobs/src/driver-memory';
import { resetJobs } from '../../packages/jobs/src/job';
import { ScriptError } from '../lib/script-error';
import { awaitReady, workerArgs, workerReport } from './worker-throughput.bench';
import { registerNoopJob, workerPod, workerPodArgs } from './worker-throughput-child';
import { NOOP_JOB, throughputOf, WORKER_PROFILES } from './worker-throughput-shape';

afterEach(() => {
  resetJobs();
});

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
  } catch (error) {
    return error instanceof ScriptError ? error.code : 'not a ScriptError';
  }
  return undefined;
};

const streamOf = (chunks: readonly string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

describe('worker throughput bench', () => {
  test('one pod claims and acks every queued no-op job', async () => {
    const driver = memoryJobDriver();
    registerNoopJob();
    registerNoopJob(); // a second call in one process declares nothing twice
    await driver.enqueueMany(
      Array.from({ length: 5 }, (_, n) => ({
        name: NOOP_JOB,
        queue: 'default',
        input: { n },
        idempotencyKey: String(n),
        maxAttempts: 1,
        runAt: 0,
      })),
    );
    const worker = workerPod(driver, { concurrency: 8, pollIntervalMs: 1 });
    await worker.tick();
    const stats = await worker.stats();
    expect(stats.processed).toBe(5);
    await worker.stop();
  });

  test('ready is read across chunks; a stream that ends first is a failed run', async () => {
    await awaitReady(streamOf(['{"log":1}\nrea', 'dy\nmore\n']));
    const ended = await awaitReady(streamOf(['nothing\n'])).then(
      () => 'resolved',
      (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
    );
    expect(ended).toBe('X_BENCH_RUN_FAILED');
  });

  test('flags: a Postgres url is required; a pod needs all three', () => {
    expect(codeOf(() => workerArgs([], {}))).toBe('X_CLI_BAD_FLAG');
    expect(codeOf(() => workerArgs(['--url', 'postgres://x/y', '--workers', '0'], {}))).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(workerArgs([], { TEST_DATABASE_URL: 'postgres://x/y' })).toMatchObject({
      base: 'postgres://x/y',
      counts: [1, 4, 16],
    });
    expect(codeOf(() => workerPodArgs(['--url', 'u']))).toBe('X_CLI_BAD_FLAG');
    expect(workerPodArgs(['--url', 'u', '--concurrency', '8', '--poll-ms', '250'])).toEqual({
      url: 'u',
      concurrency: 8,
      pollIntervalMs: 250,
    });
  });

  test('the report: a line per profile and worker count, or the whole JSON', () => {
    const profiles = [
      {
        ...WORKER_PROFILES[0],
        name: 'shipped' as const,
        concurrency: 8,
        pollIntervalMs: 250,
        jobsPerWorker: 400,
        runs: [throughputOf(4, 1_000, 500)],
      },
    ];
    expect(workerReport(profiles, false)).toEqual([
      'shipped, 4 workers: 2000 claims/s (500/worker, 1000 jobs in 500 ms)',
    ]);
    expect(JSON.parse(workerReport(profiles, true)[0] ?? '')).toMatchObject({
      profiles: [{ name: 'shipped' }],
    });
  });
});
