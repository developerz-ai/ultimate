// A process with no HTTP listener marks itself ready once its roles started: the scrape port's
// `/readyz` (`metrics-endpoint.ts`) is the only readiness a worker or replicator pod has, and core
// answers 503 for as long as the lifecycle stays `starting`.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { lifecycleState, resetLifecycle } from '@ultimat3/core';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-ready-fixture`;
let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  resetLifecycle();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe('unit · readiness of a listener-less process', () => {
  test('a scheduler-only process is ready once it started', async () => {
    resetLifecycle();
    running = await startRoles({
      roles: ['scheduler'],
      port: 0,
      metricsPort: 0,
      buildId: 'test',
      runtime: fixtureRuntime(ROOT),
      env: {},
      routes: [],
    });
    expect(lifecycleState()).toBe('ready');
  });
});
