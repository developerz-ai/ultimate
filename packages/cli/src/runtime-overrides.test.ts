// The seam that closes the walls, and the boot check that makes the driver split impossible.
//
// The failure case comes first, because it is the bug: `startServices` captures the drivers it
// built and `loadApp` runs after it, so an app module calling `setJobDriver(theirs)` moved the
// ambient slot and left the capture alone. Every `handle.enqueue()` then went to their queue while
// the worker claimed from Postgres — and `/_x` read the ambient one, so the dashboard agreed with
// the enqueue side and disagreed with reality. Nothing failed. Nothing logged.

import { afterEach, describe, expect, test } from 'bun:test';
import { noopPurgeDriver } from '@ultimat3/cache';
import type { UltimateError } from '@ultimat3/core';
import { logger, resetLifecycle } from '@ultimat3/core';
import { memoryRateLimitStore } from '@ultimat3/http';
import {
  createMemoryDriver,
  createMemoryEventBus,
  createMemoryOutboxStore,
  jobDriver,
  resetJobDriver,
  resetJobs,
  resetJobsFacade,
  resetTasks,
  setJobDriver,
} from '@ultimat3/jobs';
import { createMemoryDriver as createMemoryMailDriver } from '@ultimat3/mail';
import { DEFAULT_PRESENCE_TTL_MS, InProcessTransport } from '@ultimat3/realtime/server';
import { defineStorage, localDriver } from '@ultimat3/storage';
import type { RunningRoles } from './dev-roles';
import { startRoles, trustedHopsFromEnv } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { resolveServices } from './dev-services';

const ROOT = `${import.meta.dir}/../.overrides-fixture`;

function fakeRuntime(): RunningServices {
  const transport = new InProcessTransport();
  return {
    services: resolveServices(ROOT, {}),
    db: { async ping() {}, async close() {} } as unknown as RunningServices['db'],
    jobs: createMemoryDriver(),
    outbox: createMemoryOutboxStore(),
    events: createMemoryEventBus(),
    transport,
    transportDetail: 'in-process fanout',
    presenceTtlMs: DEFAULT_PRESENCE_TTL_MS,
    storage: defineStorage({ disks: { local: localDriver({ root: `${ROOT}/storage` }) } }),
    mail: createMemoryMailDriver(),
    mailDetail: 'embedded',
    purge: noopPurgeDriver(),
    purgeDetail: 'none',
    stop: async () => transport.close(),
  };
}

let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetJobDriver();
  resetJobsFacade();
  resetJobs();
  resetTasks();
  resetLifecycle();
});

describe('an override that reaches the enqueue side but not the worker is refused', () => {
  test('a driver installed after the boot captured its own is a coded boot failure', async () => {
    const runtime = fakeRuntime();
    // Exactly what an app module doing `setJobDriver(createMemoryDriver())` at import time does:
    // `loadApp` runs after `startServices`, so this lands between the capture and `startRoles`.
    setJobDriver(createMemoryDriver());

    const boot = startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    });

    // The whole point: it is refused, with a code, and the fix names the field that does work.
    await expect(boot).rejects.toThrow(/X_RUNTIME_DRIVER_SPLIT/);
    const error = await boot.catch((thrown: unknown) => thrown);
    expect((error as UltimateError).fix).toContain('runtime: { jobs: yourDriver }');
  });

  test('the same driver on both sides boots — the check refuses divergence, not installation', async () => {
    const runtime = fakeRuntime();
    // What `dev-queue.ts` does: install the driver it is about to hand back, so the two agree.
    setJobDriver(runtime.jobs);

    running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    });
    expect(running.worker).not.toBeNull();
    expect(jobDriver()).toBe(runtime.jobs);
  });

  test('no ambient driver at all is not a split — a test boots a role without a queue', async () => {
    const runtime = fakeRuntime();
    resetJobDriver();
    running = await startRoles({
      roles: ['worker'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
    });
    expect(running.roles).toEqual(['worker']);
  });
});

describe('the web role reads the seams startRoles never passed', () => {
  test("a shared rate-limit store makes the config say 'shared', not the literal", async () => {
    const runtime = fakeRuntime();
    const store = { ...memoryRateLimitStore(), scope: 'shared' as const };
    running = await startRoles({
      roles: ['web'],
      port: 0,
      buildId: 'test',
      runtime,
      env: {},
      routes: [],
      overrides: { rateLimitStore: store },
    });
    // Declared and enforced together: `assertRateLimitScope` would have refused the boot if the
    // config said `'shared'` and the installed store did not.
    expect(running.server?.config.rateLimit.scope).toBe('shared');
  });

  test('a per-process store the host PASSED is warned about, with the multiplier it enforces', async () => {
    const lines: string[] = [];
    const original = logger.warn;
    logger.warn = (line: string) => lines.push(line);
    try {
      running = await startRoles({
        roles: ['web'],
        port: 0,
        buildId: 'test',
        runtime: fakeRuntime(),
        env: {},
        routes: [],
        // `memoryRateLimitStore()` is `scope: 'process'`, which `assertRateLimitScope` cannot
        // refuse: the config derives its scope from this very object, so the two agree and the
        // boot is legal. What is left to say is what it COSTS, which nothing said.
        overrides: { rateLimitStore: memoryRateLimitStore() },
      });
    } finally {
      logger.warn = original;
    }
    const warned = lines.find((line) => line.includes('per process'));
    expect(warned).toContain('3x every number');
    expect(warned).toContain('runtime.rateLimitStore');
    expect(running.server?.config.rateLimit.scope).toBe('process');
  });

  test('no store is one process, declared — never the silent default that shipped 3x the limit', async () => {
    running = await startRoles({
      roles: ['web'],
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: {},
      routes: [],
    });
    expect(running.server?.config.rateLimit.scope).toBe('process');
  });

  test('TRUSTED_PROXY_HOPS is what turns trustProxy on; unset is a laptop with no proxy', async () => {
    running = await startRoles({
      roles: ['web'],
      port: 0,
      buildId: 'test',
      runtime: fakeRuntime(),
      env: { TRUSTED_PROXY_HOPS: '2' },
      routes: [],
    });
    expect(running.server?.config.trustProxy).toBe(true);
    expect(running.server?.config.trustedProxyHops).toBe(2);
  });
});

describe('unit · TRUSTED_PROXY_HOPS', () => {
  test('unset, empty and blank all mean nothing in front of this process', () => {
    expect(trustedHopsFromEnv({})).toBeNull();
    expect(trustedHopsFromEnv({ TRUSTED_PROXY_HOPS: '' })).toBeNull();
    expect(trustedHopsFromEnv({ TRUSTED_PROXY_HOPS: '  ' })).toBeNull();
  });

  test('a count is read whole', () => {
    expect(trustedHopsFromEnv({ TRUSTED_PROXY_HOPS: '1' })).toBe(1);
    expect(trustedHopsFromEnv({ TRUSTED_PROXY_HOPS: ' 3 ' })).toBe(3);
  });

  test('a malformed count is refused, never defaulted — the wrong index trusts the client', () => {
    // `Number.parseInt` reads `2abc` as 2, which is a deployment reading the header one entry too
    // far left and calling whatever the caller typed its `ctx.ip`.
    for (const value of ['2abc', '0', '-1', '1.5', 'yes', '99']) {
      expect(() => trustedHopsFromEnv({ TRUSTED_PROXY_HOPS: value })).toThrow(/X_PORT_INVALID/);
    }
  });
});
