// `health.readiness`: what a failing dependency does to `/readyz`. Failure cases first — a draining
// process is unready in every mode, a bad mode is refused — then the one behaviour `'process'`
// changes, and the default it must not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import {
  configureLifecycle,
  drain,
  healthzPayload,
  markReady,
  readyzPayload,
  registerReadinessCheck,
  resetLifecycle,
} from './lifecycle';

beforeEach(() => resetLifecycle());
afterEach(() => resetLifecycle());

describe("health.readiness: 'process'", () => {
  test('draining is 503 in process mode — the one thing a load balancer must always hear', async () => {
    configureLifecycle({ readiness: 'process', readinessGraceMs: 0 });
    registerReadinessCheck('database', () => true);
    markReady();
    const drained = drain('SIGTERM');
    expect(readyzPayload().status).toBe(503);
    expect(readyzPayload().body.state).toBe('draining');
    await drained;
  });

  test('starting is 503 in process mode', () => {
    configureLifecycle({ readiness: 'process' });
    expect(readyzPayload().status).toBe(503);
  });

  test('a mode that is not one is refused, naming the key', () => {
    expect(() => configureLifecycle({ readiness: 'lenient' as never })).toThrow(
      /health\.readiness/,
    );
    expect(() => defineConfig({ name: 'app', health: { readiness: 'x' as never } })).toThrow(
      /health\.readiness/,
    );
  });

  test('a database outage stays 200, and the body still names the failing check and the build', () => {
    configureLifecycle({ readiness: 'process' });
    let up = false;
    registerReadinessCheck('database', () => up);
    markReady();

    const payload = readyzPayload();
    expect(payload.status).toBe(200);
    expect(payload.body.ready).toBe(true);
    expect(payload.body.checks).toEqual({ database: 'failing' });
    expect(payload.body.buildId).toBeString();
    // Monitoring's view: `?deep=1` answers on the dependencies whatever the mode.
    expect(readyzPayload({ deep: true }).status).toBe(503);
    expect(readyzPayload({ deep: true }).body.ready).toBe(false);

    up = true;
    expect(readyzPayload({ deep: true }).status).toBe(200);
  });

  test("a check registered as degradable reports 'degraded' and never fails readiness", () => {
    // A dependency the role can serve without: the bus of a role that only publishes to it.
    let up = false;
    registerReadinessCheck('transport', () => up, { onFailure: 'degraded' });
    registerReadinessCheck('database', () => true);
    markReady();

    // The DEFAULT mode: the kubelet routes on this, and a dead bus must not empty the ingress.
    const shallow = readyzPayload();
    expect(shallow.status).toBe(200);
    expect(shallow.body.ready).toBe(true);
    expect(shallow.body.checks).toEqual({ transport: 'degraded', database: 'ok' });
    // Monitoring's view is strict: anything short of 'ok' is a 503 a monitor can alert on.
    expect(readyzPayload({ deep: true }).status).toBe(503);
    expect(readyzPayload({ deep: true }).body.checks).toEqual({
      transport: 'degraded',
      database: 'ok',
    });

    up = true;
    expect(readyzPayload().body.checks).toEqual({ transport: 'ok', database: 'ok' });
    expect(readyzPayload({ deep: true }).status).toBe(200);
  });

  test('a degradable check that THROWS is degraded too, and a failing one beside it still fails', () => {
    // The runtime's own SyntaxError: what a check reading a torn-down client really raises.
    registerReadinessCheck('transport', () => JSON.parse('gone') === true, {
      onFailure: 'degraded',
    });
    markReady();
    expect(readyzPayload().status).toBe(200);
    expect(readyzPayload().body.checks).toEqual({ transport: 'degraded' });

    registerReadinessCheck('database', () => false);
    expect(readyzPayload().status).toBe(503);
  });

  test('the default is unchanged: a failing check is 503', () => {
    expect(defineConfig({ name: 'app' }).health.readiness).toBe('dependencies');
    registerReadinessCheck('database', () => false);
    markReady();
    expect(readyzPayload().status).toBe(503);
    expect(readyzPayload({ deep: false }).status).toBe(503);
    // Liveness never read the checks, in either mode.
    expect(healthzPayload().status).toBe(200);
  });
});
