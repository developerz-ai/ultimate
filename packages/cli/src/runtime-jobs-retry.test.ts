// `jobs.maxAttempts` / `jobs.backoff` as the retry of a job that declares none: installed by the
// boot for every role (`startServices`), by name, and never by reading the worker's config.
// Split from `runtime-jobs.test.ts` at the size ceiling.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun ships no `tmpdir()`; `node:os` is the only way to ask for the platform's.
import { tmpdir } from 'node:os';
// why: Bun ships no path-joining API.
import { join } from 'node:path';
import { job, purge, resetJobs, t } from '@ultimat3/jobs';
import { resetDefaultRetry } from '@ultimat3/jobs/adapter';
import { loadAppConfig } from './app-config-load';
import { resolveServices } from './runtime-bindings';
import { installJobsRetry, workerConfigOf } from './runtime-jobs';
import { startServices } from './runtime-services';

const dirs: string[] = [];

async function appRoot(source: string | undefined): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'x-jobs-retry-'));
  dirs.push(root);
  if (source !== undefined) await Bun.write(join(root, 'app.config.ts'), source);
  return root;
}

// The install is process-wide; no later file inherits it.
afterEach(() => {
  resetDefaultRetry();
  resetJobs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEVEN_FIXED =
  "export const config = { name: 'demo', jobs: { maxAttempts: 7, backoff: 'fixed' } };\n";

describe('jobs.maxAttempts and jobs.backoff', () => {
  test('jobs.maxAttempts and jobs.backoff reach a job that declares no retry', async () => {
    // Built BEFORE the config is read, as an app's job modules are.
    const sweep = purge({ name: 'sweep', targets: () => [] });
    const own = job({
      tenant: 'none',
      name: 'own',
      input: t.object({}),
      idempotencyKey: () => 'own',
      retry: { attempts: 2 },
      run: () => Promise.resolve(),
    });
    expect(sweep.retry).toMatchObject({ attempts: 3, backoff: 'exponential' });

    installJobsRetry(await loadAppConfig(await appRoot(SEVEN_FIXED)));

    expect(sweep.retry).toMatchObject({ attempts: 7, backoff: 'fixed' });
    // A job's own `retry` overrides the count; the curve it does not name is the app's.
    expect(own.retry).toMatchObject({ attempts: 2, backoff: 'fixed' });
  });

  test('a root with no app.config.ts leaves the framework default, and clears an earlier one', async () => {
    const sweep = purge({ name: 'sweep', targets: () => [] });
    installJobsRetry(await loadAppConfig(await appRoot(SEVEN_FIXED)));
    expect(sweep.retry.attempts).toBe(7);

    installJobsRetry(await loadAppConfig(await appRoot(undefined)));
    expect(sweep.retry).toMatchObject({ attempts: 3, backoff: 'exponential' });
  });

  test('reading the worker config installs nothing', async () => {
    const sweep = purge({ name: 'sweep', targets: () => [] });
    workerConfigOf(await loadAppConfig(await appRoot(SEVEN_FIXED)));
    expect(sweep.retry).toMatchObject({ attempts: 3, backoff: 'exponential' });
  });

  test(
    'the boot installs it for a role that runs no worker',
    async () => {
      const sweep = purge({ name: 'sweep', targets: () => [] });
      const root = await appRoot(SEVEN_FIXED);
      const env = { ULTIMATE_ENV: 'development' } as const;
      const runtime = await startServices(resolveServices(root, env), env, undefined, 'apply', [
        'web',
      ]);
      try {
        expect(sweep.retry).toMatchObject({ attempts: 7, backoff: 'fixed' });
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );
});
