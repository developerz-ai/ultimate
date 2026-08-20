// Pins the honest-stub contract: every method of the redis driver throws
// JobsNotImplementedError naming the method and the exact runnable fix, so an accidental
// partial implementation (someone wires `enqueue` but forgets `ack`) fails a test instead of
// silently dropping jobs in production.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { createRedisDriver } from './driver-redis';
import { JobsNotImplementedError } from './errors';

const FIX =
  'call setJobDriver(createPgDriver()) at boot instead of this driver, then move what is already queued: x jobs drain --to memory --json';

// Every stub method throws SYNCHRONOUSLY (`unavailable` is `throw`, not a rejected promise), so
// the call under test has to happen inside the try — passed as a promise, `driver.enqueue(...)`
// would already have thrown while building the argument, before `expectUnavailable` runs at all.
//
// The assertion is on that immediate throw and nothing else. `await call()` would have accepted a
// returned rejected promise too, so a method rewritten to `return Promise.reject(unavailable(...))`
// passed a suite whose entire subject is that it does not — and the returned promise is drained
// here rather than dropped, or the failure arrives as an unhandled rejection in some later test.
function expectUnavailable(call: () => Promise<unknown>, featureSubstring: string): void {
  let thrown: unknown;
  let returned: Promise<unknown> | undefined;
  try {
    returned = call();
  } catch (error) {
    thrown = error;
  }
  if (returned !== undefined) void Promise.resolve(returned).catch(() => undefined);

  expect(returned).toBeUndefined();
  expect(thrown).toBeInstanceOf(JobsNotImplementedError);
  expect(thrown).toBeInstanceOf(UltimateError);
  const ultimateError = thrown as UltimateError;
  expect(ultimateError.code).toBe('X_NOT_IMPLEMENTED');
  expect(ultimateError.cause).toContain(featureSubstring);
  expect(ultimateError.fix).toBe(FIX);
}

test('driver.name is "redis"', () => {
  expect(createRedisDriver().name).toBe('redis');
});

test('createRedisDriver() takes no options and createRedisDriver({...}) is also accepted', () => {
  expect(createRedisDriver({ url: 'redis://localhost:6379', consumerGroup: 'workers' }).name).toBe(
    'redis',
  );
});

const stepRecord = {
  runId: 'run-1',
  name: 'step-1',
  status: 'completed' as const,
  startedAt: 0,
  attempts: 1,
};

describe('every queue method throws synchronously, naming itself', () => {
  test('enqueue', () => {
    const driver = createRedisDriver();
    expectUnavailable(
      () =>
        driver.enqueue({
          name: 'send',
          queue: 'default',
          input: {},
          idempotencyKey: 'k',
          maxAttempts: 3,
        }),
      'enqueue',
    );
  });

  test('claim', () => {
    const driver = createRedisDriver();
    expectUnavailable(
      () =>
        driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 1000, workerId: 'w1' }),
      'claim',
    );
  });

  test('ack', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.ack('job-1'), 'ack');
  });

  test('nack', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.nack('job-1', { delayMs: 1000 }), 'nack');
  });

  test('heartbeat', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.heartbeat('job-1', { visibilityTimeoutMs: 1000 }), 'heartbeat');
  });

  test('stats', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.stats(), 'stats');
  });
});

describe('every steps method throws synchronously, naming itself as steps.<method>', () => {
  test('steps.get', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.steps.get('run-1', 'step-1'), 'steps.get');
  });

  test('steps.put', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.steps.put(stepRecord), 'steps.put');
  });

  test('steps.list', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.steps.list('run-1'), 'steps.list');
  });

  test('steps.del', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.steps.del('run-1', 'step-1'), 'steps.del');
  });

  test('steps.clear', () => {
    const driver = createRedisDriver();
    expectUnavailable(() => driver.steps.clear('run-1'), 'steps.clear');
  });
});

// Mutation check: if `ack` (or any method) were accidentally wired to resolve instead of
// throw, the corresponding test above must go red. Proven here directly rather than by
// editing the source file: a driver built with one method patched to succeed is the same
// mutation, applied at the boundary the interface actually exposes.
describe('mutation check — a method that starts resolving instead of throwing fails its test', () => {
  function withAckPatchedToSucceed(): JobDriver {
    const driver = createRedisDriver();
    return { ...driver, ack: () => Promise.resolve() };
  }

  function withEnqueuePatchedToSucceed(): JobDriver {
    const driver = createRedisDriver();
    return {
      ...driver,
      enqueue: () => Promise.resolve({ id: 'fake', runId: 'fake', deduped: false }),
    };
  }

  function withStepsPutPatchedToSucceed(): JobDriver {
    const driver = createRedisDriver();
    return { ...driver, steps: { ...driver.steps, put: () => Promise.resolve() } };
  }

  test('a patched ack no longer throws — proving the real ack does', async () => {
    const patched = withAckPatchedToSucceed();
    await expect(patched.ack('job-1')).resolves.toBeUndefined();
    // The real driver, unpatched, still rejects: the patch above is a genuine mutation of
    // behaviour, not a no-op that would have passed either way.
    expectUnavailable(() => createRedisDriver().ack('job-1'), 'ack');
  });

  test('a patched enqueue no longer throws — proving the real enqueue does', async () => {
    const patched = withEnqueuePatchedToSucceed();
    await expect(
      patched.enqueue({
        name: 'x',
        queue: 'default',
        input: {},
        idempotencyKey: 'k',
        maxAttempts: 1,
      }),
    ).resolves.toEqual({ id: 'fake', runId: 'fake', deduped: false });
    expectUnavailable(
      () =>
        createRedisDriver().enqueue({
          name: 'x',
          queue: 'default',
          input: {},
          idempotencyKey: 'k',
          maxAttempts: 1,
        }),
      'enqueue',
    );
  });

  test('a patched steps.put no longer throws — proving the real steps.put does', async () => {
    const patched = withStepsPutPatchedToSucceed();
    await expect(patched.steps.put(stepRecord)).resolves.toBeUndefined();
    expectUnavailable(() => createRedisDriver().steps.put(stepRecord), 'steps.put');
  });
});
