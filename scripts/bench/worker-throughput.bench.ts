#!/usr/bin/env bun
// Claims per second the shipped Postgres queue sustains at 1, 4 and 16 worker PROCESSES — each its
// own `bun` process, its own pool, the stock `jobWorker` — over no-op jobs, so what is timed is
// claim + ack and nothing an app's handler adds. Two profiles (`WORKER_PROFILES`): the defaults,
// whose poll floor is the ceiling, and a tuned one that finds the queue's. Elapsed is the SERVER's: from
// `now()` before the first enqueue to the last ack's `updated_at`. A fresh probe database per run.
//
//   bun run scripts/bench/worker-throughput.bench.ts [--url postgres://…] [--workers 1,4,16]
//     [--out <file.json>] [--json]
//
// `--url` defaults to `TEST_DATABASE_URL` (`docker/test-services.env`).

import { probeDatabaseName } from '../../packages/core/src/index';
import type { PostgresClient } from '../../packages/db/src/index';
import { postgresClient, raw } from '../../packages/db/src/index';
import { postgresJobDriver } from '../../packages/jobs/src/driver-pg';
import { SQL_JOBS_TABLE } from '../../packages/jobs/src/driver-pg-sql';
import { parseScriptArgs } from '../lib/args';
import { ScriptError } from '../lib/script-error';
import { boxFacts } from './http-hello';
import {
  NOOP_JOB,
  parseWorkerCounts,
  type ThroughputRun,
  throughputOf,
  WORKER_PROFILES,
  type WorkerProfile,
} from './worker-throughput-shape';

const CHILD = Bun.fileURLToPath(new URL('./worker-throughput-child.ts', import.meta.url));
const RUN_TIMEOUT_MS = 300_000;

const failed = (cause: string): ScriptError =>
  new ScriptError({
    code: 'X_BENCH_RUN_FAILED',
    cause,
    fix: 'bun run scripts/bench/worker-throughput.bench.ts --workers 1',
  });

const dbUrl = (base: string, name: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};

/**
 * Resolve once `stdout` printed `ready`, then keep draining it: a worker logs a line per job, and a
 * full pipe would stall it mid-run — the bench would then be timing its own back-pressure.
 */
export async function awaitReady(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  let seen = '';
  while (!seen.includes('ready')) {
    const { value, done } = await reader.read();
    if (done) throw failed('a worker process exited before it printed ready');
    seen += new TextDecoder().decode(value);
  }
  void (async () => {
    while (!(await reader.read()).done) {}
  })();
}

/** Spawn `count` worker processes and resolve once every one has printed `ready`. */
async function spawnWorkers(
  count: number,
  url: string,
  profile: WorkerProfile,
): Promise<readonly Bun.Subprocess[]> {
  const argv = [
    '--url',
    url,
    '--concurrency',
    String(profile.concurrency),
    '--poll-ms',
    String(profile.pollIntervalMs),
  ];
  const children = Array.from({ length: count }, () =>
    Bun.spawn(['bun', CHILD, ...argv], {
      stdout: 'pipe',
      stderr: 'inherit',
      // Every run SIGTERMs its workers; this ends one a hung run left behind.
      timeout: RUN_TIMEOUT_MS + 60_000,
    }),
  );
  await Promise.all(
    children.map((child) => awaitReady(child.stdout as ReadableStream<Uint8Array>)),
  );
  return children;
}

async function oneRun(
  admin: PostgresClient,
  base: string,
  workers: number,
  profile: WorkerProfile,
): Promise<ThroughputRun> {
  const jobs = Math.max(1_000, profile.jobsPerWorker * workers);
  const name = probeDatabaseName('x_bench_workers');
  await admin.execute(raw(`create database ${name}`));
  const url = dbUrl(base, name);
  const client = postgresClient({ url, role: 'web', profile: { max: 2 } });
  const children: Bun.Subprocess[] = [];
  try {
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    children.push(...(await spawnWorkers(workers, url, profile)));
    const driver = postgresJobDriver({
      executor: {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          client.query<R>({ text, values }),
      },
    });
    const [start] = await client.query<{ at: string }>({
      text: 'select (extract(epoch from clock_timestamp()) * 1000)::bigint as at',
      values: [],
    });
    const requests = Array.from({ length: jobs }, (_, n) => ({
      name: NOOP_JOB,
      queue: 'default',
      input: { n },
      idempotencyKey: String(n),
      maxAttempts: 1,
      runAt: 1,
    }));
    for (let at = 0; at < requests.length; at += 1_000) {
      await driver.enqueueMany(requests.slice(at, at + 1_000));
    }
    const deadline = performance.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const [row] = await client.query<{ done: number; last: string | null }>({
        text: `select count(*)::int as done,
                      (extract(epoch from max(updated_at)) * 1000)::bigint as last
                 from x_jobs where state = 'done'`,
        values: [],
      });
      if ((row?.done ?? 0) >= jobs) {
        return throughputOf(workers, jobs, Number(row?.last) - Number(start?.at));
      }
      if (performance.now() > deadline) throw failed(`${workers} workers never drained the queue`);
      await Bun.sleep(50);
    }
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => child.exited));
    await client.close();
    await admin.execute(raw(`drop database if exists ${name} with (force)`));
  }
}

export interface ProfileRuns extends WorkerProfile {
  readonly runs: readonly ThroughputRun[];
}

export async function benchWorkers(
  base: string,
  counts: readonly number[],
  profiles: readonly WorkerProfile[] = WORKER_PROFILES,
): Promise<readonly ProfileRuns[]> {
  const admin = postgresClient({ url: base, role: 'web', profile: { max: 1 } });
  try {
    const out: ProfileRuns[] = [];
    for (const profile of profiles) {
      const runs: ThroughputRun[] = [];
      for (const workers of counts) runs.push(await oneRun(admin, base, workers, profile));
      out.push({ ...profile, runs });
    }
    return out;
  } finally {
    await admin.close();
  }
}

/** The Postgres url and worker counts, or the refusal naming them. */
export function workerArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const args = parseScriptArgs(argv);
  const base = args.flags.get('url') ?? env['TEST_DATABASE_URL'];
  const counts = parseWorkerCounts(args.flags.get('workers'));
  if (typeof base !== 'string' || counts === undefined) {
    throw new ScriptError({
      code: 'X_CLI_BAD_FLAG',
      cause:
        'worker-throughput needs a Postgres url (--url or TEST_DATABASE_URL), --workers as whole numbers 1..64',
      fix: 'bun run scripts/bench/worker-throughput.bench.ts --url postgres://ultimate:ultimate@127.0.0.1:5432/postgres --workers 1,4,16',
    });
  }
  const out = args.flags.get('out');
  return { base, counts, out: typeof out === 'string' ? out : undefined, json: args.json };
}

/** What a run prints: the whole JSON, or one line per profile and worker count. */
export function workerReport(profiles: readonly ProfileRuns[], json: boolean): readonly string[] {
  if (json) return [JSON.stringify({ box: boxFacts(Bun.env), profiles }, null, 2)];
  return profiles.flatMap((profile) =>
    profile.runs.map(
      (run) =>
        `${profile.name}, ${run.workers} workers: ${run.claimsPerSecond} claims/s (${run.perWorker}/worker, ${run.jobs} jobs in ${run.elapsedMs} ms)`,
    ),
  );
}

if (import.meta.main) {
  const args = workerArgs(Bun.argv.slice(2), Bun.env);
  const profiles = await benchWorkers(args.base, args.counts);
  const data = { box: boxFacts(Bun.env), profiles };
  if (args.out !== undefined) await Bun.write(args.out, `${JSON.stringify(data, null, 2)}\n`);
  for (const line of workerReport(profiles, args.json)) console.log(line);
}
