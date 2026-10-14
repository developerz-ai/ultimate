// The scrape port is never one of the process's own role ports. Bound to `localhost` where that
// names both `::1` and `127.0.0.1`, two listeners on one number BOTH succeed — one per address
// family — and a browser's requests reach `/metrics`'s `not found` instead of the app (CI,
// 2026-10-14). So the collision is refused by number, before either binds, on every host alike.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises'; // why: Bun has no recursive remove, only a per-file delete.
import { resetLifecycle } from '@ultimat3/core';
import { MetricsPortSharedError, startMetricsEndpoint } from './metrics-endpoint';
import type { RunningRoles } from './role-start';
import { startRoles } from './role-start';
import { fixtureRuntime, resetDevRolesState } from './role-start-fixture';

const ROOT = `${import.meta.dir}/../.roles-metrics-port-fixture`;
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

/** A port nothing holds, released at once — the number a caller would put in `METRICS_PORT`. */
const releasedPort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
};

const boot = (roles: readonly ('web' | 'sync')[], port: number, metricsPort: number) =>
  startRoles({
    roles: [...roles],
    port,
    metricsPort,
    buildId: 'build-metrics-port',
    runtime: fixtureRuntime(ROOT),
    // DECLARED, as an operator's METRICS_PORT is: an undeclared one under `x dev` frees instead.
    env: { METRICS_PORT: String(metricsPort) },
    routes: [],
  });

describe('unit · the scrape port is apart from the role ports', () => {
  test('METRICS_PORT equal to the web port is refused by name, before anything binds', async () => {
    resetLifecycle();
    const port = releasedPort();
    const refused = await boot(['web'], port, port).then(
      (roles) => {
        running = roles;
        return expect.unreachable('a scrape port equal to the web port booted');
      },
      (error: unknown) => error,
    );
    expect(refused).toBeUltimateError('X_PORT_IN_USE');
    expect(refused).toMatchObject({ cause: expect.stringContaining(`web port ${String(port)}`) });
    expect(refused).toMatchObject({ fix: expect.not.stringContaining(`METRICS_PORT=${port} `) });
  });

  test('so is the web port’s neighbour when the sync node is bound on it', async () => {
    resetLifecycle();
    const port = releasedPort();
    const refused = await boot(['web', 'sync'], port, port + 1).then(
      (roles) => {
        running = roles;
        return expect.unreachable('a scrape port equal to the sync port booted');
      },
      (error: unknown) => error,
    );
    expect(refused).toBeUltimateError('X_PORT_IN_USE');
    expect(refused).toMatchObject({
      cause: expect.stringContaining(`sync port ${String(port + 1)}`),
    });
  });
});

test('unit · the fix names 9090, or a port past every role port when a role holds 9090', () => {
  const web = { role: 'web', port: 3000 };
  expect(new MetricsPortSharedError({ port: 3000, with: web, reserved: [web] }).fix).toContain(
    'METRICS_PORT=9090 ',
  );
  const held = [
    { role: 'web', port: 9090 },
    { role: 'sync', port: 9091 },
  ];
  const fix = new MetricsPortSharedError({
    port: 9090,
    with: { role: 'web', port: 9090 },
    reserved: held,
  }).fix;
  expect(fix).toContain('METRICS_PORT=9092 ');
});

test('unit · x dev with no METRICS_PORT (`free`) takes a free scrape port beside --port 9090', () => {
  const web = { role: 'web', port: 9090 };
  const scrape = startMetricsEndpoint({
    port: 9090,
    whenTaken: 'free',
    reserved: [web, { role: 'sync', port: 9091 }],
  });
  try {
    const bound = Number(new URL(scrape.url).port);
    expect(bound).toBeGreaterThan(0);
    expect([9090, 9091]).not.toContain(bound);
  } finally {
    scrape.stop();
  }
});
