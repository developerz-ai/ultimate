// `jobs.queues`, `jobs.concurrency` and `jobs.visibilityTimeoutMs` as the worker obeys them: read
// off the app's own `app.config.ts`, and the served queue set never narrower than what the app's
// own jobs are enqueued on.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `Object.keys(Bun)` has `file`,
// `write` and `Glob`, and nothing that makes or removes a directory tree.
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask the platform where its temporary
// directory is.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API, so the temp root and the config file are joined with this.
import { join } from 'node:path';
import { isUltimateError, setLogSink } from '@ultimat3/core';
import { job, resetJobs, t } from '@ultimat3/jobs';
import { loadAppConfig } from './app-config-load';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import {
  WORKER_QUEUES_ENV,
  workerConfigOf,
  workerOptionsFor,
  workerQueuesFor,
  workerQueuesFromEnv,
} from './runtime-jobs';

const loadWorkerConfig = async (root: string) => workerConfigOf(await loadAppConfig(root));

const dirs: string[] = [];

async function appRoot(source: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-worker-config-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('workerConfigOf, over the one loader', () => {
  test('reads the three keys the worker takes out of the app own config', async () => {
    const root = await appRoot(
      "export const config = { name: 'demo', jobs: { queues: ['default', 'mail'], concurrency: 3, visibilityTimeoutMs: 45000, maxAttempts: 5 } };\n",
    );
    expect(await loadWorkerConfig(root)).toEqual({
      queues: ['default', 'mail'],
      exact: false,
      configured: ['default', 'mail'],
      concurrency: 3,
      visibilityTimeoutMs: 45_000,
    });
  });

  test('no file leaves the worker its own defaults', async () => {
    const none = {
      queues: [],
      exact: false,
      configured: [],
      concurrency: undefined,
      visibilityTimeoutMs: undefined,
    };
    expect(await loadWorkerConfig(await appRoot(undefined))).toEqual(none);
  });

  // Core's defaults, the ones the app's own `config` object holds — a hand-built object with no
  // section used to read as "the worker's own", disagreeing with that object.
  test('a config with no jobs section is core default: <name>-default, 8, 30 s', async () => {
    expect(
      await loadWorkerConfig(await appRoot("export const config = { name: 'demo' };\n")),
    ).toEqual({
      queues: ['demo-default'],
      exact: false,
      configured: ['demo-default'],
      concurrency: 8,
      visibilityTimeoutMs: 30_000,
    });
  });
});

describe('workerQueuesFor', () => {
  test('the configured queues first, then every queue a registered job is enqueued on', () => {
    expect(workerQueuesFor(['mail', 'digest'], ['default', 'mail'])).toEqual([
      'mail',
      'digest',
      'default',
    ]);
  });

  // `x new` and the demo configure `['<app>-default']`, while a `job()` naming no queue lands on
  // `default`. Serving the configured list alone would leave every such job queued for ever.
  test('a job on a queue the config never named is still served', () => {
    expect(workerQueuesFor(['myapp-default'], ['default'])).toEqual(['myapp-default', 'default']);
  });

  test('nothing configured and nothing registered is the worker default', () => {
    expect(workerQueuesFor([], [])).toBeUndefined();
  });
});

describe('startRoles hands the worker its configured queues', () => {
  const ROOT = `${import.meta.dir}/../.worker-config-fixture`;
  let running: RunningRoles | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
    resetDevRolesState();
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  test('the configured queues, then the queue a registered job is enqueued on', async () => {
    job({
      name: 'worker-config-probe',
      input: t.object({}),
      tenant: 'none' as const,
      idempotencyKey: () => 'probe',
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    const runtime = {
      ...fixtureRuntime(ROOT),
      workerConfig: {
        queues: ['mail'],
        exact: false,
        configured: ['mail'],
        concurrency: 2,
        visibilityTimeoutMs: undefined,
      },
    };
    running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    });
    expect((await running.worker?.stats())?.queues).toEqual(['mail', 'default']);
  });
});

/** The `X_CONFIG_INVALID` a call threw, or a verdict naming that nothing was refused. */
function refusal(run: () => unknown): { readonly cause: string; readonly fix: string } {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_CONFIG_INVALID') {
      return { cause: error.cause, fix: error.fix };
    }
    throw error;
  }
  return expect.unreachable('the value was accepted');
}

/** The `X_WORKER_QUEUE_UNKNOWN` a call threw, or a verdict naming that nothing was refused. */
function unknownQueue(run: () => unknown): {
  readonly cause: string;
  readonly fix: string;
  readonly meta: unknown;
} {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_WORKER_QUEUE_UNKNOWN') {
      return { cause: error.cause, fix: error.fix, meta: error.meta };
    }
    throw error;
  }
  return expect.unreachable('the queues were accepted');
}

/** A `WORKER_QUEUES` worker over `jobs.queues` = `configured`. */
const exactConfig = (queues: readonly string[], configured: readonly string[]) => ({
  queues,
  exact: true,
  configured,
  concurrency: undefined,
  visibilityTimeoutMs: undefined,
});

/** Every structured line logged while `run` runs, parsed. */
function logged(run: () => void): readonly Record<string, unknown>[] {
  const lines: string[] = [];
  const previous = setLogSink((line) => {
    lines.push(line);
  });
  try {
    run();
  } finally {
    setLogSink(previous);
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const probeJob = (name: string, queue: string): void => {
  job({
    name,
    queue,
    input: t.object({}),
    tenant: 'none' as const,
    idempotencyKey: () => name,
    retry: { attempts: 1 },
    run: () => Promise.resolve(),
  });
};

// Issue #673: a Deployment that serves `banks` must claim `banks` and nothing else. The image and
// `app.config.ts` are the same for every Deployment, so the per-Deployment answer is the env.
describe('WORKER_QUEUES — the exact queues this worker serves', () => {
  afterEach(() => {
    resetJobs();
  });

  test('unset or blank is not saying, so the config and the union apply', () => {
    expect(workerQueuesFromEnv({})).toBeUndefined();
    expect(workerQueuesFromEnv({ [WORKER_QUEUES_ENV]: '  ' })).toBeUndefined();
  });

  test('a comma-separated list, trimmed and deduplicated, in the order written', () => {
    expect(workerQueuesFromEnv({ [WORKER_QUEUES_ENV]: ' banks, banks-long,banks ' })).toEqual([
      'banks',
      'banks-long',
    ]);
  });

  test('an empty entry is refused rather than skipped: it is a queue somebody meant to name', () => {
    const { cause, fix } = refusal(() => workerQueuesFromEnv({ [WORKER_QUEUES_ENV]: 'banks,,x' }));
    expect(cause).toContain('WORKER_QUEUES');
    expect(cause).toContain('an empty queue name');
    expect(fix).toContain('WORKER_QUEUES=banks,x');
  });

  test('set, it replaces jobs.queues for this process and marks the set exact', () => {
    const config = workerConfigOf(
      { jobs: { queues: ['bank-default'], concurrency: 4, visibilityTimeoutMs: 30_000 } } as never,
      { [WORKER_QUEUES_ENV]: 'banks' },
    );
    expect(config).toEqual({
      queues: ['banks'],
      exact: true,
      configured: ['bank-default'],
      concurrency: 4,
      visibilityTimeoutMs: 30_000,
    });
  });

  test('an exact worker claims only its queues, and says which registered ones it leaves', () => {
    probeJob('exact-short-probe', 'banks');
    probeJob('exact-long-probe', 'banks-long');
    probeJob('exact-default-probe', 'default');
    let options: ReturnType<typeof workerOptionsFor> | undefined;
    const lines = logged(() => {
      options = workerOptionsFor({
        queues: ['banks'],
        exact: true,
        configured: [],
        concurrency: undefined,
        visibilityTimeoutMs: undefined,
      });
    });
    expect(options?.queues).toEqual(['banks']);
    const unserved = lines.find((line) => line['msg'] === 'jobs.worker.queue-unserved');
    expect(unserved?.['queues']).toEqual(['banks-long', 'default']);
    expect(unserved?.['served']).toEqual(['banks']);
    expect(String(unserved?.['fix'])).toContain('WORKER_QUEUES');
  });

  test('an exact worker that serves every registered queue says nothing', () => {
    probeJob('exact-served-probe', 'banks');
    const lines = logged(() => {
      workerOptionsFor({
        queues: ['banks'],
        exact: true,
        configured: [],
        concurrency: undefined,
        visibilityTimeoutMs: undefined,
      });
    });
    expect(lines.some((line) => line['msg'] === 'jobs.worker.queue-unserved')).toBe(false);
  });

  // 2026-10-27, a bank app: `WORKER_QUEUES=banks-*,banks,default` booted a worker that claimed a
  // queue nothing is enqueued on, logged it at info, and stayed Ready while every run waited.
  test('an entry no registered job and no jobs.queues entry names refuses the boot', () => {
    probeJob('unknown-banks-probe', 'banks');
    probeJob('unknown-default-probe', 'default');
    const error = unknownQueue(() =>
      workerOptionsFor(exactConfig(['banks', 'bankz'], ['bank-default'])),
    );
    expect(error.cause).toContain('"bankz"');
    expect(error.cause).toContain('bank-default, banks, default');
    expect(error.cause).not.toContain('never expanded');
    expect(error.fix).toStartWith('WORKER_QUEUES=banks on this Deployment');
    expect(error.meta).toEqual({
      key: WORKER_QUEUES_ENV,
      unknown: ['bankz'],
      known: ['bank-default', 'banks', 'default'],
    });
  });

  test('a pattern is a literal name, refused, and its fix is the expansion it meant', () => {
    probeJob('pattern-ve-probe', 'banks-ve');
    probeJob('pattern-pa-probe', 'banks-pa');
    probeJob('pattern-long-probe', 'banks-long-ve');
    probeJob('pattern-banks-probe', 'banks');
    probeJob('pattern-default-probe', 'default');
    const error = unknownQueue(() =>
      workerOptionsFor(exactConfig(['banks-*', 'banks', 'default'], [])),
    );
    expect(error.cause).toContain('"banks-*"');
    expect(error.cause).toContain('banks-* is a literal queue name');
    expect(error.fix).toStartWith(
      'WORKER_QUEUES=banks-long-ve,banks-pa,banks-ve,banks,default on this Deployment',
    );
  });

  test('a bare * is refused too: it names no queue', () => {
    probeJob('star-probe', 'default');
    const error = unknownQueue(() => workerOptionsFor(exactConfig(['*'], [])));
    expect(error.cause).toContain('"*"');
    expect(error.fix).toStartWith('WORKER_QUEUES=default on this Deployment');
  });

  test('an app with no queue at all gets a placeholder fix, never an empty list', () => {
    const error = unknownQueue(() => workerOptionsFor(exactConfig(['bankz'], [])));
    expect(error.cause).toContain('the queues this app knows are none');
    expect(error.fix).toStartWith('WORKER_QUEUES=<queue>,<queue> on this Deployment');
  });

  // The production shape that must keep booting (bank-integrations, 2026-10-27): every run is
  // enqueued onto a per-country queue chosen at enqueue time, so no job declares those queues —
  // `jobs.worker.queue-unregistered` names them at info — and the app's config lists them, computed.
  test('per-country queues only a computed jobs.queues lists boot, off the real loader', async () => {
    probeJob('per-country-banks-probe', 'banks');
    probeJob('per-country-default-probe', 'default');
    const countries = ['ve', 'pa', 'ky', 'do', 'test'];
    const root = await appRoot(
      `const countries = ${JSON.stringify(countries)};\nexport const config = { name: 'banks', jobs: { queues: [...countries.map((c) => 'banks-' + c), 'banks', 'default'] } };\n`,
    );
    const listed = 'banks-ve,banks-pa,banks-ky,banks-do,banks-test,banks,default';
    const config = workerConfigOf(await loadAppConfig(root), { [WORKER_QUEUES_ENV]: listed });
    expect(workerOptionsFor(config).queues).toEqual(listed.split(','));

    const pattern = workerConfigOf(await loadAppConfig(root), {
      [WORKER_QUEUES_ENV]: 'banks-*,banks,default',
    });
    const error = unknownQueue(() => workerOptionsFor(pattern));
    expect(error.fix).toStartWith(
      'WORKER_QUEUES=banks-do,banks-ky,banks-pa,banks-test,banks-ve,banks,default on this Deployment',
    );
  });

  test('every entry the app knows boots, including one only jobs.queues lists', () => {
    probeJob('known-banks-probe', 'banks');
    const options = workerOptionsFor(exactConfig(['banks', 'per-call'], ['per-call']));
    expect(options.queues).toEqual(['banks', 'per-call']);
  });

  test('without it the union stands: a registered queue the config never named is served', () => {
    probeJob('union-probe', 'default');
    const options = workerOptionsFor({
      queues: ['bank-default'],
      exact: false,
      configured: ['bank-default'],
      concurrency: undefined,
      visibilityTimeoutMs: undefined,
    });
    expect(options.queues).toEqual(['bank-default', 'default']);
  });
});

// The refusal reaches the boot: `startRoles` rejects with the code and rolls back what it started,
// so a container exits and the rolling update stalls on the old pods instead of serving nothing.
describe('startRoles refuses a worker whose WORKER_QUEUES the app does not know', () => {
  const ROOT = `${import.meta.dir}/../.worker-unknown-fixture`;

  afterEach(async () => {
    resetJobs();
    resetDevRolesState();
    await rm(ROOT, { recursive: true, force: true });
  });

  test('the boot rejects with X_WORKER_QUEUE_UNKNOWN', async () => {
    probeJob('boot-unknown-probe', 'banks');
    const runtime = { ...fixtureRuntime(ROOT), workerConfig: exactConfig(['banks-*'], []) };
    const code = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    }).then(
      async (running) => {
        await running.stop();
        return 'booted';
      },
      (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
    );
    expect(code).toBe('X_WORKER_QUEUE_UNKNOWN');
  });
});

// Issue #676: one process serving two queues gives them different slot counts from the config.
describe('jobs.concurrency as a table, handed to the worker', () => {
  afterEach(() => {
    resetJobs();
  });

  // As written: `jobWorker` reads the table by own key and runs a queue it leaves out at core's
  // `JOBS_CONCURRENCY_DEFAULT` (`packages/jobs/src/worker-options.test.ts`) — one slot default.
  test('the table reaches jobWorker as written', () => {
    probeJob('table-probe', 'default');
    const table = { banks: 4, 'banks-long': 2 };
    const options = workerOptionsFor({
      queues: ['banks', 'banks-long'],
      exact: false,
      configured: ['banks', 'banks-long'],
      concurrency: table,
      visibilityTimeoutMs: undefined,
    });
    expect(options.concurrency).toEqual(table);
  });

  test('a booted worker takes the table and serves exactly its queues', async () => {
    const ROOT = `${import.meta.dir}/../.worker-table-fixture`;
    const runtime = {
      ...fixtureRuntime(ROOT),
      workerConfig: {
        queues: ['banks', 'banks-long'],
        exact: true,
        configured: ['banks', 'banks-long'],
        concurrency: { banks: 4, 'banks-long': 2 },
        visibilityTimeoutMs: undefined,
      },
    };
    const running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    });
    try {
      expect((await running.worker?.stats())?.queues).toEqual(['banks', 'banks-long']);
    } finally {
      await running.stop();
      resetDevRolesState();
      await rm(ROOT, { recursive: true, force: true });
    }
  });
});
