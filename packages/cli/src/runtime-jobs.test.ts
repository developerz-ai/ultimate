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
      concurrency: 3,
      visibilityTimeoutMs: 45_000,
    });
  });

  test('no file leaves the worker its own defaults', async () => {
    const none = {
      queues: [],
      exact: false,
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
        concurrency: undefined,
        visibilityTimeoutMs: undefined,
      });
    });
    expect(lines.some((line) => line['msg'] === 'jobs.worker.queue-unserved')).toBe(false);
  });

  test('without it the union stands: a registered queue the config never named is served', () => {
    probeJob('union-probe', 'default');
    const options = workerOptionsFor({
      queues: ['bank-default'],
      exact: false,
      concurrency: undefined,
      visibilityTimeoutMs: undefined,
    });
    expect(options.queues).toEqual(['bank-default', 'default']);
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
