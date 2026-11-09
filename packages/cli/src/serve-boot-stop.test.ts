// A served app's `stop()` gives back everything its boot acquired. It released four hand-listed
// steps and skipped the rest of the unwind list: the failure-capture store (and its in-flight
// bundles) and the row-security client stayed installed over a pool `runtime.stop()` had closed.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { installedFailureStore, resetLifecycle } from '@ultimat3/core';
import { installFailureStore } from '@ultimat3/core/adapter';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-stop-fixture'));

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  installFailureStore(null);
  resetLifecycle();
});

describe('unit · ServedApp.stop releases the whole boot', () => {
  test('the failure-capture store armed at boot is taken back out at stop', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-stop-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-stop-fixture', failureCapture: { enabled: true } });\n",
    );
    installFailureStore(null);
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };
    const worker = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    expect(installedFailureStore()).not.toBeNull();
    await worker.stop();
    expect(installedFailureStore()).toBeNull();
  }, 120_000);
});
