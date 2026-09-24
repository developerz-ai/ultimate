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
import { job, t } from '@ultimat3/jobs';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { loadWorkerConfig, workerQueuesFor } from './runtime-jobs';

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

describe('loadWorkerConfig', () => {
  test('reads the three keys the worker takes out of the app own config', async () => {
    const root = await appRoot(
      "export const config = { jobs: { queues: ['default', 'mail'], concurrency: 3, visibilityTimeoutMs: 45000, maxAttempts: 5 } };\n",
    );
    expect(await loadWorkerConfig(root)).toEqual({
      queues: ['default', 'mail'],
      concurrency: 3,
      visibilityTimeoutMs: 45_000,
    });
  });

  test('no file and no section leave the worker its own defaults', async () => {
    const none = { queues: [], concurrency: undefined, visibilityTimeoutMs: undefined };
    expect(await loadWorkerConfig(await appRoot(undefined))).toEqual(none);
    expect(await loadWorkerConfig(await appRoot("export const config = { name: 'a' };\n"))).toEqual(
      none,
    );
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
      workerConfig: { queues: ['mail'], concurrency: 2, visibilityTimeoutMs: undefined },
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
