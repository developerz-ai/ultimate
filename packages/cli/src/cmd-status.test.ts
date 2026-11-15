// `x status` reads what the running deployment records about itself and nothing else: the live
// worker rows (`x_job_workers`, each stamped with its build) and the `x-ultimate-build` header each
// sampled origin answers `/readyz` with. A real health port answers the samples here.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { markReady, resetLifecycle, resetListeners } from '@ultimat3/core';
import type { WorkerAnnouncement } from '@ultimat3/jobs';
import { memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import { REQUIRED_BUN } from './app-root';
import { PLANNED_COMMANDS } from './cmd-planned';
import { statusCommand } from './cmd-status';
import type { CommandContext } from './command';
import { exec } from './exec';
import { type MetricsEndpoint, startMetricsEndpoint } from './metrics-endpoint';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';

const dirs: string[] = [];
const endpoints: MetricsEndpoint[] = [];
afterEach(() => {
  for (const endpoint of endpoints.splice(0)) endpoint.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetJobDriver();
  resetListeners();
  resetLifecycle();
});

const appRoot = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'x-status-'));
  dirs.push(dir);
  await Bun.write(join(dir, 'app.config.ts'), "export const config = { name: 'fixture' };\n");
  return dir;
};

const run = async (argv: readonly string[]): Promise<CommandResult> => {
  const ctx: CommandContext = {
    args: parseArgs(['status', ...argv], SPECS),
    cwd: await appRoot(),
    runner: exec,
    env: {},
    bunVersion: REQUIRED_BUN,
  };
  return statusCommand.run(ctx);
};

const worker = (id: string, build?: string, draining = false): WorkerAnnouncement => ({
  id,
  host: `${id}.pod`,
  startedAt: 1,
  queues: ['default'],
  concurrency: 4,
  inFlight: [],
  ...(build === undefined ? {} : { build }),
  ...(draining ? { draining } : {}),
});

/** A real role health port: the socket `worker`, `scheduler` and `replicator` answer `/readyz` on. */
const healthPort = (role: string, build?: string): string => {
  const endpoint = startMetricsEndpoint({ port: 0, role });
  if (build !== undefined) endpoint.announceBuild(build);
  endpoints.push(endpoint);
  return endpoint.url;
};

type Json = Record<string, unknown>;
const dataOf = (result: CommandResult): Json => result.data as Json;

describe('unit · x status is shipped', () => {
  test('it is a registered command, and no longer a planned one', () => {
    expect(PLANNED_COMMANDS.some((planned) => planned.name === 'status')).toBe(false);
    expect(commandFor('status')?.spec.summary.endsWith('(planned)')).toBe(false);
  });
});

describe('unit · the worker half: x_job_workers, one build per live row', () => {
  test('two builds and an unstamped row are a distribution, draining counted apart', async () => {
    const driver = memoryJobDriver();
    await driver.introspect?.announceWorker(worker('w1', 'b-new'), 60_000);
    await driver.introspect?.announceWorker(worker('w2', 'b-new'), 60_000);
    await driver.introspect?.announceWorker(worker('w3', 'b-old', true), 60_000);
    await driver.introspect?.announceWorker(worker('w4'), 60_000);
    installJobDriver(driver);
    const result = await run(['--json']);
    expect(result.ok).toBe(true);
    const workers = dataOf(result)['workers'] as Json;
    expect(workers['count']).toBe(4);
    expect(workers['draining']).toBe(1);
    expect(workers['byBuild']).toEqual({ 'b-new': 2, 'b-old': 1, unknown: 1 });
    const rows = workers['rows'] as Json[];
    expect(rows.map((row) => [row['id'], row['build'], row['draining']])).toEqual([
      ['w1', 'b-new', false],
      ['w2', 'b-new', false],
      ['w3', 'b-old', true],
      ['w4', null, false],
    ]);
    // No origin asked: the web half is absent, never an empty "nothing answered".
    expect(dataOf(result)['origins']).toEqual([]);
  });

  // A stamp is a stamp, whatever it holds: counted under its own name, with every control escaped
  // where it is printed — the human lines and the `--json` document alike.
  test('a worker row stamped with terminal controls is counted under its name, escaped', async () => {
    const driver = memoryJobDriver();
    await driver.introspect?.announceWorker(worker('w1', 'b\u009b2J'), 60_000);
    await driver.introspect?.announceWorker(worker('w2', 'release 31.27.0'), 60_000);
    installJobDriver(driver);
    const result = await run([]);
    const workers = dataOf(result)['workers'] as Json;
    expect(workers['byBuild']).toEqual({ 'b\\u009b2J': 1, 'release 31.27.0': 1 });
    expect((workers['rows'] as Json[]).map((row) => row['build'])).toEqual([
      'b\\u009b2J',
      'release 31.27.0',
    ]);
    expect(JSON.stringify(result)).not.toContain('\u009b');
  });

  test('roles no fleet-wide record covers are named, so silence is never read as health', async () => {
    installJobDriver(memoryJobDriver());
    const result = await run(['--json']);
    expect(dataOf(result)['unrecorded']).toEqual(['web', 'sync', 'scheduler', 'replicator']);
    expect((dataOf(result)['workers'] as Json)['count']).toBe(0);
  });
});

describe('unit · the origin half: /readyz and x-ultimate-build', () => {
  test('a health port answers its build and role on every sample', async () => {
    installJobDriver(memoryJobDriver());
    markReady();
    const url = healthPort('scheduler', 'b-7');
    const result = await run(['--url', url, '--samples', '3', '--json']);
    const [origin] = dataOf(result)['origins'] as Json[];
    expect(origin).toEqual({
      origin: url,
      samples: 3,
      roles: ['scheduler'],
      byBuild: { 'b-7': 3 },
      byStatus: { '200': 3 },
      unstamped: 0,
    });
  });

  test('a process that announced no build is counted unstamped, a 503 by its status', async () => {
    installJobDriver(memoryJobDriver());
    // Never marked ready: `/readyz` answers 503, with no build header yet.
    const url = healthPort('worker');
    const [origin] = dataOf(await run(['--url', url, '--samples', '2', '--json']))[
      'origins'
    ] as Json[];
    expect(origin?.['byStatus']).toEqual({ '503': 2 });
    expect(origin?.['byBuild']).toEqual({});
    // Unstamped is a 2xx with no header — a 503 is not a stamp question.
    expect(origin?.['unstamped']).toBe(0);
  });

  test('a legal build with a space is counted as itself; a hostile one escaped', async () => {
    installJobDriver(memoryJobDriver());
    markReady();
    const plain = healthPort('worker', 'release 31.27.0');
    const hostile = healthPort('worker', 'v1\u009b2J');
    const origins = dataOf(await run(['--url', `${plain},${hostile}`, '--samples', '1', '--json']))[
      'origins'
    ] as Json[];
    expect(origins.map((origin) => [origin['byBuild'], origin['unstamped']])).toEqual([
      [{ 'release 31.27.0': 1 }, 0],
      [{ 'v1\\u009b2J': 1 }, 0],
    ]);
  });

  test('a build named __proto__ is a count like any other, not a prototype write', async () => {
    installJobDriver(memoryJobDriver());
    markReady();
    const url = healthPort('worker', '__proto__');
    const [origin] = dataOf(await run(['--url', url, '--samples', '2', '--json']))[
      'origins'
    ] as Json[];
    const byBuild = origin?.['byBuild'] as Json;
    expect(Object.getOwnPropertyDescriptor(byBuild, '__proto__')?.value).toBe(2);
    expect(Object.getPrototypeOf(byBuild)).toBe(Object.prototype);
    expect(origin?.['unstamped']).toBe(0);
  });

  test('an origin nothing answers on is tallied unreachable, and the read still reports', async () => {
    installJobDriver(memoryJobDriver());
    const url = healthPort('worker', 'b-1');
    endpoints.splice(0).forEach((endpoint) => {
      endpoint.stop();
    });
    const result = await run(['--url', url, '--samples', '1', '--json']);
    expect(result.ok).toBe(true);
    const [origin] = dataOf(result)['origins'] as Json[];
    expect(origin?.['byStatus']).toEqual({ unreachable: 1 });
  });
});

describe('unit · flags refused before anything is read', () => {
  test.each([
    ['https://app.example.com/readyz', 'a path'],
    ['ftp://app.example.com', 'a scheme'],
    ['not a url', 'no url'],
    ['https://user:pw@app.example.com', 'credentials'],
  ])('--url %s (%s) is X_CLI_BAD_FLAG', async (url) => {
    installJobDriver(memoryJobDriver());
    const failure = await run(['--url', url]).catch((error: unknown) => error);
    expect(failure).toBeUltimateError('X_CLI_BAD_FLAG');
    // `x deploy verify`'s origin reader, naming this command — never the one it was borrowed from.
    expect((failure as { cause: string }).cause).toContain('"x status"');
    expect((failure as { fix: string }).fix).toStartWith('x status --url');
  });

  test.each(['0', '51', 'abc'])('--samples %s is X_CLI_BAD_FLAG', async (samples) => {
    installJobDriver(memoryJobDriver());
    await expect(
      run(['--url', 'https://app.example.com', '--samples', samples]),
    ).rejects.toBeUltimateError('X_CLI_BAD_FLAG');
  });
});
