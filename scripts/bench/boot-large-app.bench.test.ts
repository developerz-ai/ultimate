// The large-app bench's harness without the large app: one timed boot of a tiny server that is
// not ready at once, the refusal of one that never answers 200, the flags, and the pod's env and
// database URL. The whole bench is minutes of real boots; `bun run scripts/bench/boot-large-app.bench.ts`.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp directory or recursive delete of its own.
import { mkdtemp, rm } from 'node:fs/promises';
// why: as above — the platform temp root is only node:os's to name.
import { tmpdir } from 'node:os';
import { allowHost } from '../../packages/testing/src/sealed-network';
import { ScriptError } from '../lib/script-error';
import { devEnv, largeAppArgs } from './boot-large-app.bench';
import { databaseUrl, parseEnvFile } from './boot-large-app-pod';
import { timeBoot } from './boot-large-app-proc';

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

/** A server that answers 503 for its first `notReady` requests, then 200 — or exits at once. */
const SERVER = `
const notReady = Number(Bun.argv[3]);
if (notReady < 0) process.exit(3);
let seen = 0;
Bun.serve({ port: Number(Bun.argv[2]), hostname: '127.0.0.1', fetch: () =>
  new Response('x', { status: seen++ < notReady ? 503 : 200 }) });
`;

// The two servers this file starts; per host, as the seal asks.
allowHost('127.0.0.1:39411');
allowHost('127.0.0.1:39412');
allowHost('127.0.0.1:39413');

const codeOf = async (work: () => Promise<unknown>): Promise<string | undefined> =>
  work().then(
    () => undefined,
    (error: unknown) => (error instanceof ScriptError ? error.code : 'not a ScriptError'),
  );

describe('timeBoot', () => {
  test('times spawn to the first 200, past the 503s, and samples the group memory', async () => {
    const dir = await mkdtemp(`${tmpdir()}/boot-large-`);
    scratch.push(dir);
    await Bun.write(`${dir}/server.ts`, SERVER);
    const boot = await timeBoot({
      cmd: ['bun', 'server.ts', '39411', '3'],
      cwd: dir,
      env: { PATH: Bun.env['PATH'] },
      url: 'http://127.0.0.1:39411/',
      timeoutMs: 30_000,
    });
    expect(boot.toFirst200Ms).toBeGreaterThan(0);
    expect(boot.peakRssMb).toBeGreaterThan(0);
  }, 40_000);

  test('a server that exits before any 200 is X_BENCH_RUN_FAILED, never a figure', async () => {
    const dir = await mkdtemp(`${tmpdir()}/boot-large-`);
    scratch.push(dir);
    await Bun.write(`${dir}/server.ts`, SERVER);
    const code = await codeOf(() =>
      timeBoot({
        cmd: ['bun', 'server.ts', '39412', '-1'],
        cwd: dir,
        env: { PATH: Bun.env['PATH'] },
        url: 'http://127.0.0.1:39412/',
        timeoutMs: 30_000,
      }),
    );
    expect(code).toBe('X_BENCH_RUN_FAILED');
  }, 40_000);
});

test('a server that only ever answers 503 is X_BENCH_RUN_FAILED at the timeout', async () => {
  const dir = await mkdtemp(`${tmpdir()}/boot-large-`);
  scratch.push(dir);
  await Bun.write(`${dir}/server.ts`, SERVER);
  const code = await codeOf(() =>
    timeBoot({
      cmd: ['bun', 'server.ts', '39413', '1000000'],
      cwd: dir,
      env: { PATH: Bun.env['PATH'] },
      url: 'http://127.0.0.1:39413/',
      timeoutMs: 2_000,
    }),
  );
  expect(code).toBe('X_BENCH_RUN_FAILED');
}, 40_000);

describe('boot-large-app flags and pod inputs', () => {
  test('defaults: the plan’s 150 resources, 3 runs, the test Postgres', () => {
    const args = largeAppArgs([], { TEST_DATABASE_URL: 'postgres://u@h/postgres' });
    expect(args).toMatchObject({ resources: 150, runs: 3, reuse: false, keep: false, port: 3901 });
    expect(args.databaseUrl).toBe('postgres://u@h/postgres');
    expect(largeAppArgs(['--database-url', 'postgres://a@b/c'], {}).databaseUrl).toBe(
      'postgres://a@b/c',
    );
  });

  test('a count out of range is refused before anything runs', async () => {
    expect(await codeOf(async () => largeAppArgs(['--runs', '0'], {}))).toBe('X_CLI_BAD_FLAG');
    expect(await codeOf(async () => largeAppArgs(['--resources', '2.5'], {}))).toBe(
      'X_CLI_BAD_FLAG',
    );
  });

  // The stranger env hands a child `TEST_DATABASE_URL` as its `DATABASE_URL`; `x dev` then boots on
  // an external database with no replicator and refuses (`X_REALTIME_TOPOLOGY`). The dev boot this
  // bench times is the embedded one a developer runs.
  test('the dev boot is handed no DATABASE_URL, whatever the services say', () => {
    const env = devEnv(
      { PATH: '/bin', DATABASE_URL: 'postgres://u@h/t', TEST_REDIS_URL: 'r' },
      3901,
    );
    expect(env).toEqual({ PATH: '/bin', TEST_REDIS_URL: 'r', METRICS_PORT: '3903' });
  });

  test('the env file is read as KEY=value, comments and blanks skipped', () => {
    expect(parseEnvFile('# secret\n\nA=1\nB=x=y\n')).toEqual({ A: '1', B: 'x=y' });
  });

  test('the bench database replaces the server URL’s own', () => {
    expect(databaseUrl('postgres://u:p@127.0.0.1:5432/postgres', 'bench_boot_large')).toBe(
      'postgres://u:p@127.0.0.1:5432/bench_boot_large',
    );
  });
});
