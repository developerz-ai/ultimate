// TEST-ONLY. One worker child, as the production supervisor starts it: `ULTIMATE_CHILD=i/N` in its
// env, its slots from `workerOptionsFor(workerConfigOf(config, env))`. Two jobs (a CPU burn, an I/O
// wait) on queue `mc`; every start, end and lease renewal is a JSON line on stdout for the parent.

import { ctxOf, defineConfig, installLogSink } from '@ultimat3/core';
import { postgresClient } from '@ultimat3/db';
import type { JobDriver } from '@ultimat3/jobs';
import { job, jobWorker, postgresJobDriver } from '@ultimat3/jobs';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { workerConfigOf, workerOptionsFor } from './runtime-jobs';
import { writeErrorLine, writeLine } from './write-line';

const input: StandardSchemaV1<unknown, { readonly k: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as { readonly k: string } }),
  },
};

/** Burns `ms` of this process's OWN CPU time: on a shared core the wall time grows, as it should. */
export function burnCpu(ms: number): void {
  // why: Bun has no CPU-time reading of its own; `process.cpuUsage()` is the per-process counter.
  const start = process.cpuUsage();
  const spent = (): number => {
    const now = process.cpuUsage(start);
    return (now.user + now.system) / 1000;
  };
  let hash: Uint8Array = new Uint8Array(32);
  while (spent() < ms) {
    for (let i = 0; i < 200; i += 1) hash = new Bun.CryptoHasher('sha256').update(hash).digest();
  }
}

/** One worker child of the container `env` names, emitting every start, end and renewal. */
function main(env: Readonly<Record<string, string | undefined>>): void {
  const child = env['ULTIMATE_CHILD'] ?? '?';
  const emit = (event: Record<string, unknown>): void =>
    writeLine(JSON.stringify({ mc: true, child, at: Date.now(), ...event }));

  // Framework lines go to stderr (the parent inherits it) at warn and above; a lost lease is also
  // an event, the one this test exists to count.
  installLogSink((line, level) => {
    if (line.includes('jobs.lease.lost')) emit({ kind: 'lost' });
    if (level === 'warn' || level === 'error') writeErrorLine(line);
  });

  const retry = { attempts: 1, backoff: 'fixed', delay: 0, jitter: 'none' } as const;

  job({
    tenant: 'none',
    name: 'mcBurn',
    queue: 'mc',
    input,
    idempotencyKey: ({ k }) => k,
    retry,
    run: ({ input: { k } }) => {
      emit({ kind: 'start', job: 'burn', k });
      burnCpu(1_500);
      emit({ kind: 'end', job: 'burn', k });
      return Promise.resolve();
    },
  });

  job({
    tenant: 'none',
    name: 'mcIo',
    queue: 'mc',
    input,
    idempotencyKey: ({ k }) => k,
    retry,
    run: async ({ input: { k } }) => {
      emit({ kind: 'start', job: 'io', k });
      await Bun.sleep(3_000);
      emit({ kind: 'end', job: 'io', k });
    },
  });

  const client = postgresClient({ url: env['MC_DATABASE_URL'] ?? '', role: 'worker', env });
  const pg = postgresJobDriver({
    executor: {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    },
  });
  /** The renewals, observed where they happen: every `heartbeat` this worker sends, and its answer. */
  const driver: JobDriver = {
    ...pg,
    async heartbeat(jobId, options) {
      const held = await pg.heartbeat(jobId, options);
      emit({ kind: 'renew', id: jobId, held });
      return held;
    },
  };

  // Per CONTAINER: 2 slots and 2 in flight across both children, so each child runs one job.
  const config = defineConfig({
    name: 'mc',
    jobs: { queues: ['mc'], concurrency: 2, maxInFlight: 2, visibilityTimeoutMs: 3_000 },
  });
  const options = workerOptionsFor(workerConfigOf(config, env));
  const worker = jobWorker({
    driver,
    build: 'mc',
    context: () => ctxOf({ role: 'worker', buildId: 'mc' }),
    ...options,
    heartbeatIntervalMs: 300,
    pollIntervalMs: 50,
    drainOnShutdown: false,
  });
  worker.start();
  emit({ kind: 'ready', concurrency: options.concurrency, maxInFlight: options.maxInFlight });

  // The claim loop's timers are unref'd (a role's listeners hold a real process open): this holds it.
  const hold = setInterval(() => undefined, 60_000);

  process.on('SIGTERM', () => {
    clearInterval(hold);
    void worker
      .stop('test end')
      .then(() => client.close())
      .finally(() => process.exit(0));
  });
}

if (import.meta.main) main(process.env);
