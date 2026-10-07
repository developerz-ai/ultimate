// `WORKER_QUEUES` reaches the worker through the boot's OWN env (issue #673): `startServices` is
// handed the environment, so a Deployment's value is read there — never off `process.env`, which
// a test or an embedding host does not set — and a malformed one refuses the boot.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { resetAuthLimiters } from '@ultimat3/auth';
import { isUltimateError } from '@ultimat3/core';
import { processRoot } from './process-root-fixture';
import { resolveServices } from './runtime-bindings';
import { startServices } from './runtime-services';

const ROOT = processRoot(join(import.meta.dir, '..', '.services-worker-queues-fixture'));
const STATE = mkdtempSync(join(tmpdir(), 'x-worker-queues-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  resetAuthLimiters();
});

describe('unit · WORKER_QUEUES, off the env the boot is handed', () => {
  test(
    'names the exact queues, over jobs.queues; a malformed value refuses the boot',
    async () => {
      rmSync(ROOT, { recursive: true, force: true });
      await Bun.write(
        join(ROOT, 'app.config.ts'),
        `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({
  name: 'worker-queues-fixture',
  realtime: { enabled: false },
  jobs: { queues: ['bank-default'], concurrency: { banks: 4, 'banks-long': 2 } },
});
`,
      );
      const env = {
        ULTIMATE_ENV: 'development',
        ULTIMATE_STATE_DIR: STATE,
        WORKER_QUEUES: 'banks-long',
      };
      const runtime = await startServices(resolveServices(ROOT, env), env);
      try {
        expect(runtime.workerConfig?.queues).toEqual(['banks-long']);
        expect(runtime.workerConfig?.exact).toBe(true);
        expect(runtime.workerConfig?.concurrency).toEqual({ banks: 4, 'banks-long': 2 });
      } finally {
        await runtime.stop();
      }

      const bad = { ...env, WORKER_QUEUES: 'banks,' };
      const code = await startServices(resolveServices(ROOT, bad), bad).then(
        async (started) => {
          await started.stop();
          return 'booted';
        },
        (error: unknown) => (isUltimateError(error) ? error.code : 'uncoded'),
      );
      expect(code).toBe('X_CONFIG_INVALID');
    },
    { timeout: 60_000 },
  );
});
