// `ULTIMATE_STATE_DIR` moves `.x/` — never the app. The boot read `app.config.ts` from
// `dirname(stateDir)`, so a state dir outside the root (the Kubernetes `readOnlyRootFilesystem`
// recipe, `docs/ops/01-kubernetes.md`) booted every declared section at its default (s2-cli #1).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { resetAuthLimiters } from '@ultimat3/auth';
import { registeredTiers } from '@ultimat3/cache';
import { processRoot } from './process-root-fixture';
import { resolveServices } from './runtime-bindings';
import { startServices } from './runtime-services';

const ROOT = processRoot(join(import.meta.dir, '..', '.services-root-fixture'));
const STATE = mkdtempSync(join(tmpdir(), 'x-state-elsewhere-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(STATE, { recursive: true, force: true });
  resetAuthLimiters();
});

describe('unit · a state dir outside the app root', () => {
  test(
    'the declared realtime, jobs and cache sections are honoured, not defaulted',
    async () => {
      rmSync(ROOT, { recursive: true, force: true });
      await Bun.write(
        join(ROOT, 'app.config.ts'),
        `import { defineConfig } from '@ultimat3/core';
export const config = defineConfig({
  name: 'services-root-fixture',
  realtime: { enabled: false },
  jobs: { queues: ['mail'], concurrency: 3 },
  cache: { tiers: ['request-memo'] },
});
`,
      );
      const env = { ULTIMATE_ENV: 'development', ULTIMATE_STATE_DIR: STATE };
      const runtime = await startServices(resolveServices(ROOT, env), env);
      try {
        expect(runtime.services.stateDir).toBe(STATE);
        expect(runtime.realtime.enabled).toBe(false);
        expect(runtime.workerConfig?.queues).toEqual(['mail']);
        expect(runtime.workerConfig?.concurrency).toBe(3);
        expect(registeredTiers().map((tier) => tier.name)).toEqual(['request-memo']);
      } finally {
        await runtime.stop();
      }
    },
    { timeout: 60_000 },
  );
});
