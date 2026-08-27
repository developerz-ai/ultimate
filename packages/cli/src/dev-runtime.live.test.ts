// `/readyz` against a real pool, because that is the only place the claim can be tested: readiness
// is what the chart's `readinessProbe` and the container healthcheck route traffic on, and until
// this file NOTHING in the tree called `registerReadinessCheck` — so `/readyz` answered 200 for
// "this process bound a socket", which is the one thing a bound socket already proves.
//
// A database that has GONE is the case, and it needs a real server: `PostgresClient.close()` is
// not it — the pool is lazy, so the next statement opens a fresh one and the process is healthy
// again. So the test drops the database out from under the running web role (`with (force)`, which
// terminates its backends), which is the failure a readiness probe exists for: the HTTP listener is
// untouched and every request that needs a row is going to fail.
//
// Skips unless `TEST_DATABASE_URL` is set. Locally:
//
//   docker run -d --name x-ready -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/dev-runtime.live.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import type { HealthReport } from '@ultimat3/core';
import { readinessCheckCount, resetLifecycle } from '@ultimat3/core';
import type { RunningRoles } from './dev-roles';
import { startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const BOOT_TIMEOUT_MS = 60_000;

let running: RunningRoles | undefined;
let runtime: RunningServices | undefined;
let root: string | undefined;

/** Its own database, because the test destroys it. Never the one `TEST_DATABASE_URL` names. */
const PROBE_DB = 'x_readyz_probe';

const probeUrl = (): string => {
  const parsed = new URL(url ?? '');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const admin = async (statement: string): Promise<void> => {
  const sql = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await sql.unsafe(statement, []);
  } finally {
    await sql.end();
  }
};

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await runtime?.stop().catch(() => undefined);
  runtime = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
  resetLifecycle();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
});

interface Readyz {
  readonly status: number;
  readonly body: HealthReport;
}

const readyz = async (base: string): Promise<Readyz> => {
  const response = await fetch(`${base}/readyz`);
  return { status: response.status, body: (await response.json()) as HealthReport };
};

/**
 * `/readyz` again until it says what the test is waiting for, or the deadline. The probe behind
 * the check is refreshed BY the read and answered from the previous one — the standard cached
 * health shape, and the reason the endpoint can never block on a slow database.
 */
async function readyzUntil(base: string, status: number): Promise<Readyz> {
  const deadline = Bun.nanoseconds() + 10_000_000_000;
  let last = await readyz(base);
  while (last.status !== status && Bun.nanoseconds() < deadline) {
    await Bun.sleep(20);
    last = await readyz(base);
  }
  return last;
}

describeLive('/readyz means the process can serve, not that it bound a socket', () => {
  test(
    'a web role whose database is gone answers 503, and names the check that failed',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'x-readyz-'));
      await admin(`drop database if exists ${PROBE_DB} with (force)`);
      await admin(`create database ${PROBE_DB}`);
      const dbUrl = probeUrl();
      runtime = await startServices(resolveServices(root, { DATABASE_URL: dbUrl }), {
        DATABASE_URL: dbUrl,
      });
      running = await startRoles({
        roles: ['web'],
        port: 0,
        metricsPort: 0,
        buildId: 'build-1',
        runtime,
        routes: [],
        env: {},
      });
      const base = running.url ?? expect.unreachable('the web role reported no url');

      const healthy = await readyzUntil(base, 200);
      expect(healthy.status).toBe(200);
      // Observed before this landed: `registered: 0` and `checks: {}` — a 200 that is vacuously
      // true, because `every` over an empty registry is `true`. The three distinguishable answers
      // are {200, no checks}, {200, N checks all ok} and {503, one failing}; this is the second.
      expect(healthy.body.registered).toBeGreaterThanOrEqual(1);
      expect(healthy.body.checks['database']).toBe('ok');

      // The database, gone, with its backends terminated — while the socket this test is talking
      // to stays bound and answering. Observed before this landed: 200, forever.
      await admin(`drop database ${PROBE_DB} with (force)`);

      const dead = await readyzUntil(base, 503);
      expect(dead.status).toBe(503);
      expect(dead.body.checks['database']).toBe('failing');
      expect(dead.body.ready).toBe(false);
      // Liveness deliberately ignores the checks: a database outage that failed liveness would
      // restart the whole fleet into the same outage, cold.
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    'every check this boot registered is released by its own stop',
    async () => {
      root = mkdtempSync(join(tmpdir(), 'x-readyz-'));
      await admin(`drop database if exists ${PROBE_DB} with (force)`);
      await admin(`create database ${PROBE_DB}`);
      const dbUrl = probeUrl();
      const before = readinessCheckCount();
      runtime = await startServices(resolveServices(root, { DATABASE_URL: dbUrl }), {
        DATABASE_URL: dbUrl,
      });
      expect(readinessCheckCount()).toBeGreaterThan(before);

      await runtime.stop();
      runtime = undefined;
      // A count that climbs across a start/stop cycle is a leak, and the second `startServices` in
      // one process would then be `X_READINESS_CHECK_DUPLICATE` rather than a boot.
      expect(readinessCheckCount()).toBe(before);
    },
    BOOT_TIMEOUT_MS,
  );
});
