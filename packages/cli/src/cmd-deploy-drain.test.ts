// The drain values a helm deploy hands the chart: `app.config.ts`'s `drain` section, the one drain
// budget every role — the web role included — runs on since 25.0.0 deleted `http.drainTimeoutMs`.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { helmDrainOverrides, readHelmDrainOverrides } from './cmd-deploy-drain';
import { helmWorkerTargetOverrides } from './cmd-deploy-helm';
import { processRoot } from './process-root-fixture';

// Inside the package, so the fixture's `@ultimat3/*` imports resolve (gitignored).
const ROOT = processRoot(join(import.meta.dir, '..', '.deploy-drain-fixture'));

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · the chart drain budget', () => {
  test('is the app drain budget, with the readiness grace beside it', () => {
    expect(helmDrainOverrides({ deadlineMs: 30_000, readinessGraceMs: 5_000 })).toEqual([
      '--set',
      'drain.deadlineSeconds=30',
      '--set',
      'drain.readinessGraceSeconds=5',
    ]);
  });

  test('rounds a budget up to whole seconds, and an app with no config sends nothing', () => {
    expect(helmDrainOverrides({ deadlineMs: 120_500 })).toContain('drain.deadlineSeconds=121');
    expect(helmDrainOverrides(undefined)).toEqual([]);
  });

  test('a worker budget sizes the worker chart role alone', () => {
    expect(
      helmDrainOverrides({
        deadlineMs: 30_000,
        readinessGraceMs: 5_000,
        workerDeadlineMs: 7_500_000,
      }),
    ).toEqual([
      '--set',
      'drain.deadlineSeconds=30',
      '--set',
      'drain.workerDeadlineSeconds=7500',
      '--set',
      'drain.readinessGraceSeconds=5',
    ]);
    expect(helmDrainOverrides({ deadlineMs: 30_000 }).join(' ')).not.toContain('workerDeadline');
  });

  test('the retire is the app config, in seconds; 0 sends 0, so an off stays off', () => {
    expect(helmDrainOverrides({ workerRetireMs: 3_600_000 })).toContain(
      'roles.worker.retireSeconds=3600',
    );
    expect(helmDrainOverrides({ workerRetireMs: 1_500 })).toContain('roles.worker.retireSeconds=2');
    const off = helmDrainOverrides({ workerRetireMs: 0 });
    expect(off.slice(0, 2)).toEqual(['--set', 'roles.worker.retireSeconds=0']);
    expect(helmDrainOverrides({ deadlineMs: 30_000 }).join(' ')).not.toContain('retireSeconds');
  });

  test('one pod’s maxInFlight is the worker target; undeclared, the chart’s value stands', () => {
    expect(helmWorkerTargetOverrides(16)).toEqual([
      '--set',
      'roles.worker.autoscaling.targetAverageValue=16',
    ]);
    expect(helmWorkerTargetOverrides(undefined)).toEqual([]);
  });

  test("a deployed app's drain.deadlineMs is read off its app.config.ts", async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'deploy-drain-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'deploy-drain-fixture', jobs: { maxInFlight: 16 }, drain: { deadlineMs: 180_000 } });\n",
    );
    const overrides = await readHelmDrainOverrides(ROOT);
    expect(overrides).toContain('drain.deadlineSeconds=180');
    // Core's default: no chart is left with its own idea of the retire.
    expect(overrides).toContain('roles.worker.retireSeconds=3600');
    expect(overrides).toContain('roles.worker.autoscaling.targetAverageValue=16');
  }, 60_000);
});
