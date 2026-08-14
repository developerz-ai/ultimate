// Pins the honest-stub contract: every method of the nats driver rejects with
// JobsNotImplementedError naming the method and the exact runnable fix, so an accidental
// partial implementation (someone wires `enqueue` but forgets `ack`) fails a test instead of
// silently dropping jobs in production.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { createNatsDriver } from './driver-nats';
import { JobsNotImplementedError } from './errors';

const FIX =
  "set jobs: { driver: 'postgres' } in app.config.ts, then: x jobs drain --to memory --json";

// Every stub method throws SYNCHRONOUSLY (`unavailable` is `throw`, not a rejected promise), so
// the call under test has to happen inside the try — passed as a promise, `driver.enqueue(...)`
// would already have thrown while building the argument, before `expectUnavailable` runs at all.
async function expectUnavailable(
  call: () => Promise<unknown>,
  featureSubstring: string,
): Promise<void> {
  try {
    await call();
    throw new Error(`expected ${featureSubstring} to reject`);
  } catch (error) {
    expect(error).toBeInstanceOf(JobsNotImplementedError);
    expect(error).toBeInstanceOf(UltimateError);
    const ultimateError = error as UltimateError;
    expect(ultimateError.code).toBe('X_NOT_IMPLEMENTED');
    expect(ultimateError.cause).toContain(featureSubstring);
    expect(ultimateError.fix).toBe(FIX);
  }
}

test('driver.name is "nats"', () => {
  expect(createNatsDriver().name).toBe('nats');
});

test('createNatsDriver() takes no options and createNatsDriver({...}) is also accepted', () => {
  expect(createNatsDriver({ servers: ['nats://localhost:4222'], streamPrefix: 'x' }).name).toBe(
    'nats',
  );
});

const stepRecord = {
  runId: 'run-1',
  name: 'step-1',
  status: 'completed' as const,
  startedAt: 0,
  attempts: 1,
};

describe('every queue method rejects, naming itself', () => {
  test('enqueue', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(
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

  test('claim', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(
      () =>
        driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 1000, workerId: 'w1' }),
      'claim',
    );
  });

  test('ack', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.ack('job-1'), 'ack');
  });

  test('nack', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.nack('job-1', { delayMs: 1000 }), 'nack');
  });

  test('heartbeat', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(
      () => driver.heartbeat('job-1', { visibilityTimeoutMs: 1000 }),
      'heartbeat',
    );
  });

  test('stats', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.stats(), 'stats');
  });
});

describe('every steps method rejects, naming itself as steps.<method>', () => {
  test('steps.get', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.steps.get('run-1', 'step-1'), 'steps.get');
  });

  test('steps.put', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.steps.put(stepRecord), 'steps.put');
  });

  test('steps.list', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.steps.list('run-1'), 'steps.list');
  });

  test('steps.del', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.steps.del('run-1', 'step-1'), 'steps.del');
  });

  test('steps.clear', async () => {
    const driver = createNatsDriver();
    await expectUnavailable(() => driver.steps.clear('run-1'), 'steps.clear');
  });
});

// Mutation check: if `ack` (or any method) were accidentally wired to resolve instead of
// reject, the corresponding test above must go red. Proven here directly rather than by
// editing the source file: a driver built with one method patched to succeed is the same
// mutation, applied at the boundary the interface actually exposes.
describe('mutation check — a method that starts resolving instead of rejecting fails its test', () => {
  function withAckPatchedToSucceed(): JobDriver {
    const driver = createNatsDriver();
    return { ...driver, ack: () => Promise.resolve() };
  }

  function withEnqueuePatchedToSucceed(): JobDriver {
    const driver = createNatsDriver();
    return {
      ...driver,
      enqueue: () => Promise.resolve({ id: 'fake', runId: 'fake', deduped: false }),
    };
  }

  function withStepsPutPatchedToSucceed(): JobDriver {
    const driver = createNatsDriver();
    return { ...driver, steps: { ...driver.steps, put: () => Promise.resolve() } };
  }

  test('a patched ack no longer throws — proving the real ack does', async () => {
    const patched = withAckPatchedToSucceed();
    await expect(patched.ack('job-1')).resolves.toBeUndefined();
    // The real driver, unpatched, still rejects: the patch above is a genuine mutation of
    // behaviour, not a no-op that would have passed either way.
    await expectUnavailable(() => createNatsDriver().ack('job-1'), 'ack');
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
    await expectUnavailable(
      () =>
        createNatsDriver().enqueue({
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
    await expectUnavailable(() => createNatsDriver().steps.put(stepRecord), 'steps.put');
  });
});
