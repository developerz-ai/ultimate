// The operator verbs over the memory driver: each answers what the queue now holds, and a driver
// with no `introspect` refuses by name instead of answering "nothing happened". The full parity of
// the members they bind is `operator-surface*-fixture.ts`; this pins the binding.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { pauseQueue, promoteJob, removeJob, resolveJobStep, resumeQueue } from './inspect-operator';

const enqueued = async (driver: JobDriver, runAt?: number) =>
  (
    await driver.enqueue({
      name: 'sweep',
      queue: 'default',
      input: {},
      idempotencyKey: `sweep:${runAt ?? 'now'}`,
      maxAttempts: 1,
      ...(runAt === undefined ? {} : { runAt }),
    })
  ).id;

describe('the operator verbs', () => {
  test('remove answers the removed row, then nothing for the same id', async () => {
    const driver = memoryJobDriver();
    const id = await enqueued(driver);
    expect((await removeJob(driver, id))?.id).toBe(id);
    expect(await removeJob(driver, id)).toBeUndefined();
  });

  test('pause and resume answer the paused list as it now stands', async () => {
    const driver = memoryJobDriver();
    expect((await pauseQueue(driver, 'mail')).map((paused) => paused.name)).toEqual(['mail']);
    expect(await resumeQueue(driver, 'mail')).toEqual([]);
  });

  test('promote refuses a job that is not waiting on its run time, naming its state', async () => {
    const driver = memoryJobDriver();
    const id = await enqueued(driver);
    const outcome = await promoteJob(driver, id).catch((error: unknown) => error);
    expect((outcome as UltimateError).code).toBe('X_JOB_NOT_PROMOTABLE');
  });

  test('a driver with no introspect refuses every verb by name', async () => {
    const { introspect: _none, ...bare } = memoryJobDriver();
    const outcome = await pauseQueue(bare, 'mail').catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UltimateError);
    expect((outcome as UltimateError).code).toBe('X_JOB_INTROSPECTION_UNSUPPORTED');
    expect((outcome as UltimateError).cause).toContain('"memory"');
  });

  // `resolveStep` stays optional on the public type (required waits on `next`), so a hand-rolled
  // surface without it reaches the guard: refused by name, never X_NOT_IMPLEMENTED.
  test('a surface with no resolveStep refuses the verb, naming the member', async () => {
    const full = memoryJobDriver();
    const operator = full.introspect;
    if (operator === undefined) return expect.unreachable('the memory driver ships introspect');
    const { resolveStep: _none, ...surface } = operator;
    const driver: JobDriver = { ...full, introspect: surface };
    const outcome = await Promise.resolve()
      .then(() => resolveJobStep(driver, 'job-1', 'send', { ran: false }))
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(UltimateError);
    expect((outcome as UltimateError).code).toBe('X_JOB_INTROSPECTION_UNSUPPORTED');
    expect((outcome as UltimateError).cause).toContain('"memory" jobs driver\'s operator surface');
    expect((outcome as UltimateError).cause).toContain('resolveStep');
    expect((outcome as UltimateError).fix).toEndWith(
      'x jobs resolve-step <id> <step> --ran --output <json>',
    );
  });

  test('the memory surface implements resolveStep', () => {
    expect(typeof memoryJobDriver().introspect?.resolveStep).toBe('function');
  });
});
