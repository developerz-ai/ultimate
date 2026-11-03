// `drain` is a process fact, not a web-server one (s1-con #7). The readiness grace reached core only
// through `httpServer`, so a worker pod kept the default grace — five seconds of claiming jobs
// after SIGTERM, every one of them aborted when the drain reached its `accept` phase.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import {
  configureLifecycle,
  drain,
  drainDeadlineMs,
  readinessGraceMs,
  resetLifecycle,
  resetTelemetry,
} from '@ultimat3/core';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';
import { lifecycleForRole } from './serve-boot';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-drain-fixture'));

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

  test('the declared drain budget reaches every role, listening or not', () => {
    // The worker is the role a long job lives on: `drain.deadlineMs` is the only knob that gives a
    // running job longer than 25 s to finish on a deploy, so dropping it for a non-listening role
    // would make the key a no-op exactly where it matters.
    for (const role of ['worker', 'scheduler', 'replicator'] as const) {
      expect(lifecycleForRole(role, { readinessGraceMs: 4_000, deadlineMs: 90_000 })).toEqual({
        readinessGraceMs: 0,
        deadlineMs: 90_000,
      });
    }
    for (const role of ['web', 'sync'] as const) {
      expect(lifecycleForRole(role, { readinessGraceMs: 4_000, deadlineMs: 90_000 })).toEqual({
        readinessGraceMs: 4_000,
        deadlineMs: 90_000,
      });
      expect(lifecycleForRole(role, { deadlineMs: 90_000 })).toEqual({ deadlineMs: 90_000 });
    }
  });

  test("drain.workerDeadlineMs is the worker's budget, and no other role's", () => {
    const drain = { readinessGraceMs: 4_000, deadlineMs: 90_000, workerDeadlineMs: 7_500_000 };
    expect(lifecycleForRole('worker', drain)).toEqual({
      readinessGraceMs: 0,
      deadlineMs: 7_500_000,
    });
    expect(lifecycleForRole('worker', { workerDeadlineMs: 7_500_000 })).toEqual({
      readinessGraceMs: 0,
      deadlineMs: 7_500_000,
    });
    for (const role of ['scheduler', 'replicator'] as const) {
      expect(lifecycleForRole(role, drain)).toEqual({ readinessGraceMs: 0, deadlineMs: 90_000 });
    }
    for (const role of ['web', 'sync'] as const) {
      expect(lifecycleForRole(role, drain)).toEqual({
        readinessGraceMs: 4_000,
        deadlineMs: 90_000,
      });
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
        "export const config = defineConfig({ name: 'serve-drain-fixture', drain: { readinessGraceMs: 4000, deadlineMs: 90000 } });\n",
    );
    // The production default (5 s outside a local environment), set the way a boot inherits it.
    configureLifecycle({ readinessGraceMs: 7_000 });
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const worker = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    try {
      expect(readinessGraceMs()).toBe(0);
      // …and with the budget `app.config.ts` declared, not the lifecycle's built-in 25 s.
      expect(drainDeadlineMs()).toBe(90_000);
    } finally {
      await worker.stop();
    }
  }, 120_000);
});

/**
 * The exporter's place in the boot is what its place in the `close` phase is: hooks run
 * last-registered first, and importing the app IS registering its hooks. Started after the import,
 * the flush ran before an app's own teardown and that teardown's span was lost.
 */
describe('unit · the exporter is started before the app is imported', () => {
  test("a span from an app's import-time close hook is delivered", async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-otlp-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-otlp-fixture' });\n",
    );
    await Bun.write(
      join(ROOT, 'apps/web/api/index.ts'),
      "import { onShutdown, withSpan } from '@ultimat3/core';\n" +
        "onShutdown('app-teardown', () => withSpan('span-from-app-teardown', async () => 0), { phase: 'close' });\n",
    );
    resetLifecycle();
    const bodies: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;
    const env = {
      NODE_ENV: 'test',
      ULTIMATE_STATE_DIR: join(ROOT, '.x'),
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
    };
    const worker = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    try {
      await drain('SIGTERM');
      expect(bodies.join('')).toContain('span-from-app-teardown');
    } finally {
      await worker.stop();
      globalThis.fetch = real;
      resetTelemetry();
      resetLifecycle();
    }
  }, 120_000);
});
