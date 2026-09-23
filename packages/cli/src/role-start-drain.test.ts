// The app's `drain` section reaches the web server a boot starts. `@ultimat3/http` only applies a
// DECLARED readiness grace, and no boot declared one: the chart's terminationGracePeriodSeconds
// was sized for a grace that `app.config.ts` could set and nothing passed on (slice 01 f → 12 h).

import { afterEach, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { readinessGraceMs, resetLifecycle } from '@ultimat3/core';
import { startMetricsEndpoint } from './metrics-endpoint';
import type { RunningRoles } from './role-start';
import { selectRoles, startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';
import { appRoutes } from './runtime-render';

const ROOT = `${import.meta.dir}/../.roles-drain-fixture`;
let running: RunningRoles | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  resetDevRolesState();
  resetLifecycle();
  await rm(ROOT, { recursive: true, force: true });
});

test("the app's declared readiness grace is the one the drain waits out", async () => {
  running = await startRoles({
    roles: selectRoles('web'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: appRoutes({ buildId: 'test' }),
    http: { dev: false, hostname: 'localhost' },
    drain: { readinessGraceMs: 1_234 },
  });
  expect(readinessGraceMs()).toBe(1_234);
});

// The container's boot opens the scrape listener BEFORE it loads the app and builds islands, so
// `/metrics` answers while a cold pod boots; `startRoles` adopts that listener rather than binding
// a second one on the same port (plan 101, slice 12 j).
test('a metrics listener the boot already opened is adopted, never bound twice', async () => {
  const early = startMetricsEndpoint({ port: 0, hostname: 'localhost' });
  running = await startRoles({
    roles: selectRoles('worker'),
    port: 0,
    buildId: 'test',
    runtime: fixtureRuntime(ROOT),
    env: {},
    routes: [],
    metrics: early,
  });
  expect(running.metricsUrl).toBe(early.url);
  const scraped = await fetch(`${early.url}/metrics`);
  expect(scraped.status).toBe(200);
});
