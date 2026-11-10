// The pure half of `worker-throughput.bench.ts`: the job both processes agree on, the worker counts
// a run may ask for, and claims per second from the server's own timestamps. Split from the
// harness so the arithmetic is tested without a database.

import type { StandardSchemaV1 } from '../../packages/schema/src/index';

/** The one job the bench queues: no body, so a claim and its ack are all that is timed. */
export const NOOP_JOB = 'benchNoop';

/** `{ n }`, checked rather than cast — the input crosses a process boundary as JSON. */
export const benchJobInput: StandardSchemaV1<unknown, { n: number }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-bench',
    validate: (value: unknown) => {
      const n =
        typeof value === 'object' && value !== null ? (value as { n?: unknown }).n : undefined;
      return typeof n === 'number' && Number.isInteger(n)
        ? { value: { n } }
        : { issues: [{ message: 'expected { n: integer }' }] };
    },
  },
};

/**
 * How a worker process is configured for a run. `shipped` is `jobWorker`'s defaults — 8 slots,
 * a pass every 250 ms while there is work — and on no-op jobs that IS the ceiling: 8 per pass, 4
 * passes a second. `tuned` raises both, to find where the QUEUE (Postgres) stops scaling instead.
 */
export interface WorkerProfile {
  readonly name: 'shipped' | 'tuned';
  readonly concurrency: number;
  readonly pollIntervalMs: number;
  /** Jobs queued per worker process, so every run lasts seconds rather than minutes or ms. */
  readonly jobsPerWorker: number;
}

export const WORKER_PROFILES: readonly WorkerProfile[] = [
  { name: 'shipped', concurrency: 8, pollIntervalMs: 250, jobsPerWorker: 400 },
  { name: 'tuned', concurrency: 32, pollIntervalMs: 10, jobsPerWorker: 2_000 },
];

/** The worker counts the plan names: one pod, four, sixteen. */
export const DEFAULT_WORKER_COUNTS: readonly number[] = [1, 4, 16];

/** `'1,4,16'` -> `[1, 4, 16]`; anything but whole numbers from 1 to 64 is `undefined`. */
export function parseWorkerCounts(
  raw: string | boolean | undefined,
): readonly number[] | undefined {
  if (raw === undefined) return DEFAULT_WORKER_COUNTS;
  if (typeof raw !== 'string') return undefined;
  const counts = raw.split(',').map((part) => Number(part.trim()));
  return counts.length > 0 && counts.every((n) => Number.isInteger(n) && n >= 1 && n <= 64)
    ? counts
    : undefined;
}

export interface ThroughputRun {
  readonly workers: number;
  readonly jobs: number;
  /** Server time from the first enqueue to the last ack, ms. */
  readonly elapsedMs: number;
  readonly claimsPerSecond: number;
  /** Throughput per worker process: how far from linear the fleet scales. */
  readonly perWorker: number;
}

/** One run's figure. Whole claims per second: a fraction of a claim is noise this bench cannot see. */
export function throughputOf(workers: number, jobs: number, elapsedMs: number): ThroughputRun {
  const claimsPerSecond = elapsedMs > 0 ? Math.round((jobs * 1_000) / elapsedMs) : 0;
  return {
    workers,
    jobs,
    elapsedMs: Math.round(elapsedMs),
    claimsPerSecond,
    perWorker: Math.round(claimsPerSecond / workers),
  };
}
