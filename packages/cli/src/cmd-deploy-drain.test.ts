// The drain values a helm deploy hands the chart: `app.config.ts`'s `drain` section, the one drain
// budget every role — the web role included — runs on since 25.0.0 deleted `http.drainTimeoutMs`.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { helmDrainOverrides, readHelmDrainOverrides } from './cmd-deploy-drain';
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

  test("a deployed app's drain.deadlineMs is read off its app.config.ts", async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'deploy-drain-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'deploy-drain-fixture', drain: { deadlineMs: 180_000 } });\n",
    );
    expect(await readHelmDrainOverrides(ROOT)).toContain('drain.deadlineSeconds=180');
  }, 60_000);
});
