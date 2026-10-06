// The drain values a helm deploy hands the chart. `http.drainTimeoutMs`, when the app declares it,
// replaces the drain budget on the web role at boot (`createServer`), so the chart must be sized
// for the LARGER of the two, or a web pod is SIGKILLed mid-drain at the smaller grace period.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { resetHttpConfig } from '@ultimat3/http';
import { helmDrainOverrides, readHelmDrainOverrides } from './cmd-deploy-drain';

// Inside the package, so the fixture's `@ultimat3/*` imports resolve (gitignored).
const ROOT = join(import.meta.dir, '..', '.deploy-drain-fixture');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  resetHttpConfig();
});

describe('unit · the chart drain budget', () => {
  test('is the app drain budget when no HTTP drain timeout is declared', () => {
    expect(helmDrainOverrides({ deadlineMs: 30_000, readinessGraceMs: 5_000 }, undefined)).toEqual([
      '--set',
      'drain.deadlineSeconds=30',
      '--set',
      'drain.readinessGraceSeconds=5',
    ]);
  });

  test('is the HTTP drain timeout when that is the larger, and never smaller than the budget', () => {
    expect(helmDrainOverrides({ deadlineMs: 25_000 }, 120_500)).toContain(
      'drain.deadlineSeconds=121',
    );
    expect(helmDrainOverrides({ deadlineMs: 60_000 }, 10_000)).toContain(
      'drain.deadlineSeconds=60',
    );
  });

  test('an HTTP timeout alone, on an app with no config, still sizes the chart', () => {
    expect(helmDrainOverrides(undefined, 90_000)).toEqual(['--set', 'drain.deadlineSeconds=90']);
  });

  test('a booted app that declared configureHttp({ drainTimeoutMs }) is read at the deploy', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'deploy-drain-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'deploy-drain-fixture' });\n",
    );
    await Bun.write(
      join(ROOT, 'apps', 'web', 'http.ts'),
      "import { configureHttp } from '@ultimat3/http';\n" +
        'configureHttp({ drainTimeoutMs: 180_000 });\n',
    );
    resetHttpConfig();
    expect(await readHelmDrainOverrides(ROOT)).toContain('drain.deadlineSeconds=180');
  }, 60_000);
});
