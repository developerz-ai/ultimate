// A background pod boots without compiling islands. Only `web` serves pages; a worker, scheduler,
// sync or replicator pod built every island of the app on every boot for nothing it would serve —
// seconds of a cold start, and an island that fails to build took down a pod that never renders.

import { afterAll, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
// why: Bun exposes no path-join primitive; Bun.write takes one already joined.
import { join } from 'node:path';
import { serveApp } from './serve';

const ROOT = join(import.meta.dir, '..', '.serve-worker-fixture');

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

test('a worker boots over an app whose island cannot even be built; web does not', async () => {
  await rm(ROOT, { recursive: true, force: true });
  await Bun.write(
    join(ROOT, 'package.json'),
    JSON.stringify({ name: 'serve-worker-fixture', version: '1.0.0' }),
  );
  await Bun.write(
    join(ROOT, 'app.config.ts'),
    "import { defineConfig } from '@ultimat3/core';\n" +
      "export const config = defineConfig({ name: 'serve-worker-fixture' });\n",
  );
  // Not valid TypeScript: building it fails, which is how a build is observed here.
  await Bun.write(join(ROOT, 'apps/web/site/broken.island.tsx'), 'export const = ;\n');
  const env = { NODE_ENV: 'test', ULTIMATE_STATE_DIR: join(ROOT, '.x') };

  const worker = await serveApp({ root: ROOT, env, role: 'worker', port: 0, metricsPort: 0 });
  expect(worker.role).toBe('worker');
  await worker.stop();

  const web = await serveApp({ root: ROOT, env, role: 'web', port: 0, metricsPort: 0 }).then(
    () => 'booted',
    (error: unknown) => (error as { code?: string }).code ?? String(error),
  );
  // The same island stops the web role, so the worker above really skipped the build. (Bun's own
  // `AggregateError` today, not `X_BUILD_FAILED` — reported to the island-bundle owner.)
  expect(web).not.toBe('booted');
}, 120_000);
