// `drain` is a process fact, not a web-server one (s1-con #7). The readiness grace reached core only
// through `createServer`, so a worker pod kept the default grace — five seconds of claiming jobs
// after SIGTERM, every one of them aborted when the drain reached its `accept` phase.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { configureLifecycle, readinessGraceMs, resetLifecycle } from '@ultimat3/core';
import { serveApp } from './serve';
import { lifecycleForRole } from './serve-boot';

const ROOT = join(import.meta.dir, '..', '.serve-drain-fixture');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetLifecycle();
});

describe('unit · the drain each role runs', () => {
  test('a role nothing routes to stops claiming at drain start: no readiness grace', () => {
    for (const role of ['worker', 'scheduler', 'replicator'] as const) {
      expect(lifecycleForRole(role, { readinessGraceMs: 4_000 })).toEqual({ readinessGraceMs: 0 });
      expect(lifecycleForRole(role, undefined)).toEqual({ readinessGraceMs: 0 });
    }
  });

  test('a listening role keeps the declared grace, and the default when none is declared', () => {
    for (const role of ['web', 'sync'] as const) {
      expect(lifecycleForRole(role, { readinessGraceMs: 4_000 })).toEqual({
        readinessGraceMs: 4_000,
      });
      expect(lifecycleForRole(role, undefined)).toEqual({});
    }
  });

  test('a booted ROLE=worker process drains with no grace, whatever was configured before it', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-drain-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-drain-fixture', drain: { readinessGraceMs: 4000 } });\n",
    );
    // The production default (5 s outside a local environment), set the way a boot inherits it.
    configureLifecycle({ readinessGraceMs: 7_000 });
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const worker = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    try {
      expect(readinessGraceMs()).toBe(0);
    } finally {
      await worker.stop();
    }
  }, 120_000);
});
