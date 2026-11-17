// An unstamped image runs with `BUILD_ID=""` (the Dockerfile's `ARG BUILD_ID=` →
// `ENV BUILD_ID=${BUILD_ID}`). The boot resolves that to the manifest hash and sends it as
// `x-ultimate-build`; core read the env itself and kept `""`, so `/healthz`, `/readyz` and a
// worker's `ctx.buildId` (the audit row's `build_id`) disagreed with the header. ONE resolver now:
// the boot installs its id into core, and releases it at stop.

import { afterAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { BUILD_ID_HEADER, ctxOf, healthReport, resetLifecycle } from '@ultimat3/core';
import { installedBuildId } from '@ultimat3/core/adapter';
import { processRoot } from './process-root-fixture';
import { serveApp } from './serve';

const ROOT = processRoot(join(import.meta.dir, '..', '.serve-build-id-fixture'));
const before = process.env['BUILD_ID'];

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  if (before === undefined) delete process.env['BUILD_ID'];
  else process.env['BUILD_ID'] = before;
  resetLifecycle();
});

describe('unit · the boot installs the build id it resolved', () => {
  test('an unstamped worker: header, health body and ctx.buildId are the manifest hash', async () => {
    await rm(ROOT, { recursive: true, force: true });
    await Bun.write(
      join(ROOT, 'package.json'),
      JSON.stringify({ name: 'serve-build-id-fixture', version: '1.0.0' }),
    );
    await Bun.write(
      join(ROOT, 'app.config.ts'),
      "import { defineConfig } from '@ultimat3/core';\n" +
        "export const config = defineConfig({ name: 'serve-build-id-fixture' });\n",
    );
    process.env['BUILD_ID'] = '';
    const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x'), BUILD_ID: '' };
    const served = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
    if (served.kind !== 'served') return expect.unreachable('a worker boot serves');
    try {
      expect(served.buildId).not.toBe('');
      const healthz = await fetch(`${served.running.metricsUrl}/healthz`);
      expect(healthz.headers.get(BUILD_ID_HEADER)).toBe(served.buildId);
      expect(healthReport().buildId).toBe(served.buildId);
      expect(ctxOf().buildId).toBe(served.buildId);
    } finally {
      await served.stop();
    }
    // Released with the boot: a later boot in this process never inherits this one's id.
    expect(installedBuildId()).toBe('dev');
  }, 120_000);
});
