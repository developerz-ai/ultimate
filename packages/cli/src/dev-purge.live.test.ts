// The boot's two halves against a real server: the limiter an app picks up without asking for it,
// and the sweep that empties the tables it fills. `dev-purge.test.ts` proves the wiring with stubs
// and can prove nothing about the statements — a purge whose SQL was never executed is a cleanup
// nobody has run, which is exactly the state all three tables shipped in.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`, because this file creates and
// drops a database. Locally:
//
//   docker run -d --name x-purge -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/dev-purge.live.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountKey, defineAuth, MemoryAdapter } from '@ultimat3/auth';
import { createContext, systemClock } from '@ultimat3/core';
import type { PurgeReport } from '@ultimat3/jobs';
import {
  createMemoryStepStore,
  createStepRunner,
  getJob,
  resetJobs,
  resetTasks,
} from '@ultimat3/jobs';
import { PURGE_JOB_NAME } from './dev-purge';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BOOT_TIMEOUT_MS = 60_000;
/** Its own database, because the boot applies DDL to it. Never the one `TEST_DATABASE_URL` names. */
const PROBE_DB = 'x_purge_probe';

let runtime: RunningServices | undefined;
let root: string | undefined;

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async (target: string, statement: string): Promise<void> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

const countIn = async (table: string): Promise<number> => {
  const sql = new Bun.SQL(probeUrl(), { max: 1 });
  try {
    const rows = (await sql.unsafe(`select count(*)::int as n from ${table}`, [])) as {
      readonly n: number;
    }[];
    return rows[0]?.n ?? 0;
  } finally {
    await sql.end();
  }
};

/** The boot every role runs, over a database this test owns. */
async function boot(): Promise<RunningServices> {
  root = mkdtempSync(join(tmpdir(), 'x-purge-'));
  await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  await on(url ?? '', `create database ${PROBE_DB}`);
  const dbUrl = probeUrl();
  runtime = await startServices(resolveServices(root, { DATABASE_URL: dbUrl }), {
    DATABASE_URL: dbUrl,
  });
  return runtime;
}

/** The registered sweep, run as a worker would run it. */
async function runSweep(): Promise<PurgeReport> {
  const handle = getJob(PURGE_JOB_NAME);
  if (handle === undefined) expect.unreachable(`${PURGE_JOB_NAME} was never declared by the boot`);
  const runner = createStepRunner({
    runId: crypto.randomUUID(),
    jobName: handle.name,
    store: createMemoryStepStore(),
  });
  const result = await handle.run({
    input: {},
    step: runner.step,
    ctx: createContext({ role: 'worker' }),
    attempt: 1,
    jobId: 'job-1',
    runId: 'run-1',
  });
  return result as PurgeReport;
}

afterEach(async () => {
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  resetJobs();
  resetTasks();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (url !== undefined) await on(url, `drop database if exists ${PROBE_DB} with (force)`);
});

describeLive('live · postgres · what the boot installs for auth and retention', () => {
  test(
    'an app that declares nothing counts its failures in the boot database',
    async () => {
      await boot();

      // The app's own call, exactly as a scaffolded `apps/web/app/auth/login.ts` writes it.
      const auth = defineAuth({ adapter: new MemoryAdapter() });
      expect(auth.limiter.policy.scope).toBe('shared');
      await auth.limiter.recordFailure(accountKey('ada@example.com'));

      // The row is in the DATABASE, not in this process's heap — which is the whole difference
      // between a lockout the fleet enforces and one each pod enforces on its own.
      expect(await countIn('x_auth_failures')).toBe(1);
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'the sweep the boot declared really runs its statements, on every table',
    async () => {
      await boot();
      const auth = defineAuth({ adapter: new MemoryAdapter() });
      const live = accountKey('ada@example.com');
      await auth.limiter.recordFailure(live);
      // Two rows from before the window and a lockout that has already expired — the rows the
      // purge exists for. Written directly, because getting there through the limiter means
      // waiting out a 15-minute window.
      await on(probeUrl(), "insert into x_auth_failures (key, at_ms) values ('account:old', 0)");
      await on(probeUrl(), "insert into x_auth_failures (key, at_ms) values ('ip:1.2.3.4', 0)");
      await on(
        probeUrl(),
        "insert into x_auth_lockouts (key, locked_until_ms) values ('ip:9.9.9.9', 1)",
      );

      const report = await runSweep();

      expect(report.swept.map((sweep) => sweep.name)).toEqual([
        'x_idempotency',
        'x_rate_limit',
        'x_auth',
      ]);
      // Three dead rows gone, the live failure kept: the purge measures against the caller's
      // clock, so a sweep that read `now()` on the server would take a different set.
      expect(report.removed).toBe(3);
      expect(await countIn('x_auth_failures')).toBe(1);
      expect(await countIn('x_auth_lockouts')).toBe(0);
      // Empty tables, so nothing to remove — but the statements ran, which is what a missing
      // relation would have failed on.
      expect(report.swept.find((sweep) => sweep.name === 'x_rate_limit')?.removed).toBe(0);
      expect(report.swept.find((sweep) => sweep.name === 'x_idempotency')?.removed).toBe(0);
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'stopping the boot hands the limiter back and leaves the sweep reaching through nothing',
    async () => {
      const started = await boot();
      await started.stop();
      runtime = undefined;

      // Back to `createAuthLimiter`: a limiter over a pool this process has closed is worse than
      // a per-process one, because every sign-in then fails instead of being counted narrowly.
      expect(defineAuth({ adapter: new MemoryAdapter() }).limiter.policy.scope).toBe('process');
      expect(await runSweep()).toEqual({ swept: [], removed: 0 });
      // The clock is the boot's own and nothing here froze it; stated so the assertion above is
      // read as "no targets", never as "the clock happened to make every sweep empty".
      expect(systemClock.now().getTime()).toBeGreaterThan(0);
    },
    BOOT_TIMEOUT_MS,
  );
});
