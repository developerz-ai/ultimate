// Single responsibility: the boot's half of where a primitive's declared `rateLimit:` is counted.
// Split from `runtime-services.test.ts` at the size ceiling. Installed at BOOT, before `loadApp`
// and before any role: a task or a one-off command runs actions too, and the store they count in
// must be the fleet's table — given back, as its own frame, when the services stop.

import { afterAll, describe, expect, test } from 'bun:test';
// why: `node:` by necessity: Bun has no temp-directory, no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { installedRateLimitStore } from '@ultimat3/http';
import { resolveServices } from './runtime-bindings';
import { startServices } from './runtime-services';

/** `x dev`'s environment — a table naming none is a production boot to the embedded disk. */
const DEV_ENV = { ULTIMATE_ENV: 'development' } as const;

const root = mkdtempSync(join(tmpdir(), 'x-dev-rate-limit-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('startServices and the rate-limit store', () => {
  test(
    'the shared store is the one primitives spend from, until stop',
    async () => {
      const runtime = await startServices(resolveServices(root, {}), DEV_ENV);
      const store = runtime.rateLimitStore;
      try {
        if (store === undefined) return expect.unreachable('a boot resolves its own store');
        expect(store.scope).toBe('shared');
        expect(installedRateLimitStore()).toBe(store);
      } finally {
        await runtime.stop();
      }
      expect(installedRateLimitStore()).not.toBe(store);
    },
    { timeout: 60_000 },
  );
});
