// `x deploy verify` end to end: the real binary, a real app's job registry, the real statements
// against a real Postgres. A child per run because `loadApp` registers into its process, and because
// the wiring from argv to `x_job_workers` is what the unit suite hands in.
//
// Skips unless `TEST_DATABASE_URL` is set — never `DATABASE_URL`: this file creates and drops a
// database.
//
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@localhost:5432/postgres \
//     bun test packages/cli/src/cmd-deploy-verify.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.spawn takes one already joined.
import { join } from 'node:path';
import { BUILD_ID_HEADER, probeDatabaseName, sweepProbeDatabases } from '@ultimat3/core';
import { dbExecutor, postgresClient } from '@ultimat3/db';
import type { JobDriver } from '@ultimat3/jobs';
import { postgresJobDriver } from '@ultimat3/jobs';
import { allowHost } from '@ultimat3/testing';
import { applyFrameworkSchema } from './framework-schema';
import { processRoot } from './process-root-fixture';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;
const PROBE_DB = probeDatabaseName('x_deploy_verify_probe');
const TIMEOUT_MS = 60_000;
const BUILD = 'b-new';
const BIN = join(import.meta.dir, 'bin.ts');
// Under `packages/cli/` so the fixture's `@ultimat3/*` imports resolve as the framework's own do.
const ROOT = processRoot(join(import.meta.dir, '..', '.deploy-verify-fixture'));

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://unset');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.href;
};

const on = async <R = unknown>(
  target: string,
  statement: string,
  values: readonly unknown[] = [],
): Promise<readonly R[]> => {
  const sql = new Bun.SQL(target, { max: 1 });
  try {
    return [...(await sql.unsafe(statement, [...values]))] as R[];
  } finally {
    await sql.end();
  }
};

const FILES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'deploy-verify-fixture', version: '1.0.0' }),
  'x.manifest.json': JSON.stringify({ buildId: BUILD }),
  'app.config.ts': `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({ name: 'deploy-verify-fixture', jobs: { queues: ['banks'] } });
`,
  'apps/web/app/digest/jobs.ts': `import { job, t } from '@ultimat3/jobs';
export const digest = job({
  name: 'digest',
  queue: 'digests',
  input: t.object({ day: t.string }),
  idempotencyKey: (input) => input.day,
  tenant: 'none',
  retry: { attempts: 1, backoff: 'fixed' },
  run: () => undefined,
});
`,
};

let server: ReturnType<typeof Bun.serve> | undefined;
let client: ReturnType<typeof postgresClient> | undefined;
let driver: JobDriver | undefined;

/** A row the way a worker writes one, through the real statement. */
const announce = (id: string, queues: readonly string[], build: string, draining = false) =>
  driver?.introspect?.announceWorker(
    {
      id,
      host: 'pod',
      startedAt: 1_000,
      queues,
      concurrency: 1,
      inFlight: [],
      build,
      ...(draining ? { draining } : {}),
    },
    60_000,
  );

const noWorkerRows = async () => {
  await on(probeUrl(), 'delete from x_job_workers');
  await on(probeUrl(), 'delete from x_jobs');
  await on(probeUrl(), 'delete from x_job_pauses');
};

const enqueue = (queue: string, key: string) =>
  driver?.enqueue({ name: 'digest', queue, input: {}, idempotencyKey: key, maxAttempts: 1 });

interface VerifyJson {
  readonly ok: boolean;
  readonly findings?: readonly { readonly code: string; readonly meta?: { queue?: string } }[];
  readonly data?: {
    readonly build?: string;
    readonly queues?: {
      readonly graded: boolean;
      readonly served: readonly string[];
      readonly idle?: readonly string[];
    };
  };
}

async function verify(
  databaseUrl: string | undefined,
  extra: readonly string[] = [],
): Promise<VerifyJson & { code: number }> {
  const { DATABASE_URL: _unset, ...env } = process.env;
  const child = Bun.spawn(
    [
      'bun',
      BIN,
      'deploy',
      'verify',
      '--url',
      `http://127.0.0.1:${server?.port}`,
      '--window',
      '0',
      '--interval',
      '50ms',
      '--timeout',
      '300ms',
      '--json',
      ...extra,
    ],
    {
      cwd: ROOT,
      env: { ...env, ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  try {
    return { ...(JSON.parse(out) as VerifyJson), code };
  } catch {
    return expect.unreachable(`x deploy verify printed no JSON: ${out} ${err}`);
  }
}

describeLive('live · x deploy verify against x_job_workers', () => {
  beforeAll(async () => {
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
    await sweepProbeDatabases(
      { query: <R>(text: string, values: readonly unknown[]) => on<R>(url ?? '', text, values) },
      PROBE_DB,
    );
    await on(url ?? '', `create database ${PROBE_DB}`);
    await applyFrameworkSchema(async (statement) => {
      await on(probeUrl(), statement);
    });
    client = postgresClient({ url: probeUrl(), profile: { max: 1 } });
    const pool = client;
    driver = postgresJobDriver({ executor: dbExecutor(() => pool) });
    for (const [path, text] of Object.entries(FILES)) await Bun.write(join(ROOT, path), text);
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response('{}', { headers: { [BUILD_ID_HEADER]: BUILD } }),
    });
    allowHost(`127.0.0.1:${server.port}`);
  }, TIMEOUT_MS);

  afterAll(async () => {
    server?.stop(true);
    await client?.close();
    await rm(ROOT, { recursive: true, force: true });
    await on(url ?? '', `drop database if exists ${PROBE_DB} with (force)`);
  }, TIMEOUT_MS);

  test(
    'every registered queue and jobs.queue with no row: red, one finding each',
    async () => {
      await noWorkerRows();
      const result = await verify(probeUrl());
      expect(result.code).toBe(1);
      expect(result.findings?.map((finding) => finding.code)).toEqual([
        'X_DEPLOY_QUEUE_UNSERVED',
        'X_DEPLOY_QUEUE_UNSERVED',
      ]);
      expect(result.findings?.map((finding) => finding.meta?.queue).sort()).toEqual([
        'banks',
        'digests',
      ]);
    },
    TIMEOUT_MS,
  );

  test(
    'a worker of the previous build, and a draining one of this build, serve nothing',
    async () => {
      await noWorkerRows();
      await announce('old', ['banks', 'digests'], 'b-old');
      await announce('leaving', ['banks', 'digests'], BUILD, true);
      const result = await verify(probeUrl());
      expect(result.code).toBe(1);
      expect(result.data?.queues?.served).toEqual([]);
    },
    TIMEOUT_MS,
  );

  test(
    'a serving worker of this build on each queue: green, and it says it graded',
    async () => {
      await noWorkerRows();
      await announce('a', ['banks'], BUILD);
      await announce('b', ['digests'], BUILD);
      const result = await verify(probeUrl());
      expect(result.ok).toBe(true);
      expect(result.code).toBe(0);
      expect(result.data?.queues).toMatchObject({ graded: true });
      expect([...(result.data?.queues?.served ?? [])].sort()).toEqual(['banks', 'digests']);
    },
    TIMEOUT_MS,
  );

  // Both read through `demand()`, the number an autoscaler sizes by. `ready + running` read each of
  // these as work the pool was missing: a false red until --timeout, on every retire.
  test(
    'a draining old worker still holding a job leaves an --idle-ok queue idle',
    async () => {
      await noWorkerRows();
      await enqueue('banks', 'held');
      await driver?.claim({
        queues: ['banks'],
        limit: 1,
        visibilityTimeoutMs: 60_000,
        workerId: 'old',
      });
      await announce('old', ['banks'], 'b-old', true);
      const result = await verify(probeUrl(), ['--idle-ok', 'banks,digests']);
      expect(result.findings ?? []).toEqual([]);
      expect(result.code).toBe(0);
      expect([...(result.data?.queues?.idle ?? [])].sort()).toEqual(['banks', 'digests']);
    },
    TIMEOUT_MS,
  );

  test(
    'a paused queue with ready rows is idle; the same rows unpaused are work with no worker',
    async () => {
      await noWorkerRows();
      await enqueue('banks', 'waiting');
      await driver?.introspect?.pauseQueue('banks');
      const paused = await verify(probeUrl(), ['--idle-ok', 'banks,digests']);
      expect(paused.findings ?? []).toEqual([]);
      expect(paused.code).toBe(0);

      await driver?.introspect?.resumeQueue('banks');
      const resumed = await verify(probeUrl(), ['--idle-ok', 'banks,digests']);
      expect(resumed.code).toBe(1);
      expect(resumed.findings?.map((finding) => finding.meta?.queue)).toEqual(['banks']);
    },
    TIMEOUT_MS,
  );

  test(
    'no DATABASE_URL: green on the build, graded false, and no embedded database appears',
    async () => {
      const result = await verify(undefined);
      expect(result.code).toBe(0);
      expect(result.data?.queues?.graded).toBe(false);
      expect(await Bun.file(join(ROOT, '.x', 'pgdata', 'PG_VERSION')).exists()).toBe(false);
    },
    TIMEOUT_MS,
  );
});
