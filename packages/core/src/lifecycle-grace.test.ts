// Single responsibility: the readiness grace — the window between `/readyz` flipping to 503 and the
// `accept` phase closing the listener. Without it Kubernetes endpoints still route to a socket that
// SIGTERM just closed, and an in-flight POST from the load balancer gets a 502.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import {
  configureLifecycle,
  drain,
  drainDeadlineMs,
  markReady,
  onShutdown,
  readinessGraceMs,
  readyzPayload,
  resetLifecycle,
} from './lifecycle';
import {
  defaultReadinessGraceMs,
  READINESS_GRACE_DEFAULT_MS,
  READINESS_GRACE_MAX_MS,
  readinessGraceIssue,
} from './lifecycle-grace';

beforeEach(() => {
  resetLifecycle();
});
afterEach(() => {
  resetLifecycle();
});

describe('the readiness grace', () => {
  test('/readyz answers 503 while the listener still accepts, for graceMs', async () => {
    configureLifecycle({ readinessGraceMs: 300 });
    markReady();
    let listenerClosedAt: number | undefined;
    onShutdown(
      'http:web',
      () => {
        listenerClosedAt = performance.now();
      },
      { phase: 'accept' },
    );

    const startedAt = performance.now();
    const drained = drain('SIGTERM');
    // Readiness flips at once — that is what tells the endpoints controller to stop routing here.
    expect(readyzPayload().status).toBe(503);
    await Bun.sleep(50);
    // …and the listener is still open, so what was already routed here is still answered.
    expect(listenerClosedAt).toBeUndefined();
    expect(readyzPayload().status).toBe(503);

    await drained;
    expect(listenerClosedAt).toBeDefined();
    expect((listenerClosedAt ?? 0) - startedAt).toBeGreaterThanOrEqual(290);
  });

  test('the grace is ADDED to the drain budget, never taken out of it', async () => {
    // The chart's terminationGracePeriodSeconds must exceed grace + deadline; a grace that ate the
    // deadline would leave the in-flight wait less than the budget an operator configured.
    configureLifecycle({ readinessGraceMs: 200, deadlineMs: 100 });
    // Measured against the DEADLINE the hook is handed, never the time left when it runs: under a
    // loaded machine the hook runs late and "time left" goes negative, which is a fact about the
    // scheduler. `deadlineAt` is fixed when the grace ends, so it sits at least grace + deadline
    // past the drain's start however slow the run is; a grace that ate the deadline puts it at 100.
    let deadlineAt: number | undefined;
    onShutdown(
      'probe',
      (reason) => {
        deadlineAt = reason.deadlineAt;
      },
      { phase: 'accept' },
    );
    const startedAt = performance.now();
    await drain('SIGTERM');
    expect((deadlineAt ?? 0) - startedAt).toBeGreaterThanOrEqual(200 + 100);
    expect(drainDeadlineMs()).toBe(100);
  });

  test('0 is no grace: the accept phase runs on the first tick', async () => {
    configureLifecycle({ readinessGraceMs: 0 });
    let closed = false;
    onShutdown(
      'http:web',
      () => {
        closed = true;
      },
      { phase: 'accept' },
    );
    const drained = drain('SIGTERM');
    await Bun.sleep(5);
    expect(closed).toBe(true);
    await drained;
  });

  test.each([Number.NaN, -1, 1.5, READINESS_GRACE_MAX_MS + 1, Number.POSITIVE_INFINITY])(
    'configureLifecycle refuses readinessGraceMs %p',
    (value) => {
      try {
        configureLifecycle({ readinessGraceMs: value });
        expect.unreachable();
      } catch (error) {
        expect(isUltimateError(error)).toBe(true);
      }
    },
  );
});

describe('the default grace fails closed', () => {
  test('no environment is production: the full grace', () => {
    expect(defaultReadinessGraceMs({})).toBe(READINESS_GRACE_DEFAULT_MS);
    expect(READINESS_GRACE_DEFAULT_MS).toBe(5000);
  });

  test.each(['development', 'test'])('%s has no grace', (environment) => {
    expect(defaultReadinessGraceMs({ NODE_ENV: environment })).toBe(0);
    expect(defaultReadinessGraceMs({ ULTIMATE_ENV: environment })).toBe(0);
  });

  test.each(['staging', 'production'])('%s has the full grace', (environment) => {
    expect(defaultReadinessGraceMs({ ULTIMATE_ENV: environment })).toBe(5000);
  });

  test('an unknown ULTIMATE_ENV is not local, so it gets the grace rather than a throw', () => {
    expect(defaultReadinessGraceMs({ ULTIMATE_ENV: 'prod' })).toBe(5000);
  });

  test('an unconfigured lifecycle reads the default from the process environment', () => {
    // `bun test` runs with NODE_ENV=test, so the process default is 0 here.
    expect(readinessGraceMs()).toBe(defaultReadinessGraceMs());
  });

  test('the screen names the key and accepts the closed range', () => {
    for (const ok of [0, 1, 5000, READINESS_GRACE_MAX_MS])
      expect(readinessGraceIssue(ok)).toBeUndefined();
    for (const bad of [Number.NaN, -1, 1.5, 60_001, '5000', null]) {
      expect(readinessGraceIssue(bad)).toContain('readinessGraceMs');
    }
  });
});
