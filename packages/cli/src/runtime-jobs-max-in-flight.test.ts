// `jobs.maxInFlight` as the worker obeys it: read off the app's own `app.config.ts`, handed to
// `jobWorker` only when the app said it, and visible on the booted worker's stats.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove — `Object.keys(Bun)` has `file`,
// `write` and `Glob`, and nothing that makes or removes a directory tree.
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask the platform where its temporary
// directory is.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API, so the temp root and the config file are joined with this.
import { join } from 'node:path';
import { resetJobs } from '@ultimat3/jobs';
import { loadAppConfig } from './app-config-load';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { workerConfigOf, workerOptionsFor } from './runtime-jobs';

const dirs: string[] = [];

async function appRoot(source: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-worker-cap-'));
  dirs.push(root);
  await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

afterEach(() => {
  resetJobs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('jobs.maxInFlight', () => {
  test('reaches jobWorker as written, and a config without it passes no cap', async () => {
    const capped = workerConfigOf(
      await loadAppConfig(
        await appRoot(
          "export const config = { name: 'demo', jobs: { queues: ['banks'], concurrency: 4, maxInFlight: 10 } };\n",
        ),
      ),
    );
    expect(capped.maxInFlight).toBe(10);
    expect(workerOptionsFor(capped).maxInFlight).toBe(10);

    const bare = workerConfigOf(
      await loadAppConfig(await appRoot("export const config = { name: 'demo' };\n")),
    );
    // Omitted, never `undefined`: the worker's own default (no cap) applies.
    expect('maxInFlight' in workerOptionsFor(bare)).toBe(false);
  });

  test('a booted worker reports the configured cap in its stats', async () => {
    const ROOT = `${import.meta.dir}/../.worker-cap-fixture`;
    const runtime = {
      ...fixtureRuntime(ROOT),
      workerConfig: {
        queues: ['banks'],
        exact: true,
        configured: ['banks'],
        concurrency: 4,
        maxInFlight: 3,
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
      expect((await running.worker?.stats())?.maxInFlight).toBe(3);
    } finally {
      await running.stop();
      resetDevRolesState();
      await rm(ROOT, { recursive: true, force: true });
    }
  });
});
