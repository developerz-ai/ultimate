// The fleet rate budget a job spends, as `wiki/Jobs-And-Workflows.md` documents it — through the
// PUBLIC API only, so the seam the recipe names is the seam this pins: `rateLimiter({ config,
// store: installedRateLimitStore() }).assert(key, bucket)` as the body's first line. A refusal is
// `X_RATE_LIMITED`, which the worker defers with the attempt UNCOUNTED: a `maxAttempts: 1` job
// refused by the bucket is retried later, never dead-lettered for having waited.

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import {
  assertRateLimitScope,
  installedRateLimitStore,
  memoryRateLimitStore,
  rateLimiter,
  resolveRateLimitConfig,
} from '@ultimat3/http';
import { installRateLimitStore, resetRateLimitStore } from '@ultimat3/http/adapter';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import { job, jobWorker, memoryJobDriver, resetJobs } from './index';

afterEach(() => {
  resetJobs();
  resetJobDriver();
  resetRateLimitStore();
});

/** One call to the vendor, then nothing for an hour: the second send in a pass is refused. */
const VENDOR = resolveRateLimitConfig({
  scope: 'shared',
  buckets: { vendor: { capacity: 1, refillPerSecond: 1 / 3_600 } },
  defaultBucket: 'vendor',
});

describe('a job spends a declared vendor bucket', () => {
  test('the refused run is retried with its attempt unspent, and not dead-lettered', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    // The boot installs the fleet's Postgres store on every role; one store this process shares
    // stands in for it, so `'shared'` is honest here.
    installRateLimitStore({ ...memoryRateLimitStore(), scope: 'shared' });
    const sent: string[] = [];
    const send = job({
      name: 'rate-recipe-send',
      tenant: 'none',
      input: t.object({ to: t.string }),
      idempotencyKey: ({ to }) => `send:${to}`,
      retry: { attempts: 1 },
      async run({ input, step }) {
        // First, ahead of the first step: a refusal replays nothing.
        const vendor = rateLimiter({ config: VENDOR, store: installedRateLimitStore() });
        assertRateLimitScope(VENDOR, vendor);
        await vendor.assert('acme-mail', 'vendor');
        await step.run('send', () => {
          sent.push(input.to);
          return Promise.resolve();
        });
      },
    });
    const [first, second] = await send.enqueueMany([{ to: 'a' }, { to: 'b' }]);

    const worker = jobWorker({
      driver,
      context: () => ctxOf({ role: 'worker' }),
      drainOnShutdown: false,
      concurrency: 1,
    });
    try {
      const executions = [...(await worker.tick()), ...(await worker.tick())];

      expect(sent).toHaveLength(1);
      expect(executions.map((execution) => execution.outcome).sort()).toEqual([
        'completed',
        'retried',
      ]);
      const refused = executions.find((execution) => execution.outcome === 'retried');
      const row = await driver.introspect?.job(refused?.jobId ?? '');
      expect(row?.attempt).toBe(0);
      expect(row?.state === 'ready' || row?.state === 'delayed').toBe(true);
      expect(row?.runAt).toBeGreaterThan(Date.now());
      expect([first?.id, second?.id]).toContain(refused?.jobId);
    } finally {
      await worker.stop('test');
    }
  });
});
