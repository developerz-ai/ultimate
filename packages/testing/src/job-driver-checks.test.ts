// The empty-queue-list check can fail: a driver whose `claim` reads `queues: []` as "every queue"
// is caught by it, and the memory driver, which refuses, passes it.

import { describe, expect, test } from 'bun:test';
import type { JobDriver } from '@ultimat3/jobs';
import { memoryJobDriver } from '@ultimat3/jobs';
import { JOB_DRIVER_CHECKS } from './job-driver-checks';

const emptyQueues = JOB_DRIVER_CHECKS.find((each) => each.name.startsWith('an empty queue list'));

/** The memory driver, with an empty queue list widened to the default queue before it arrives. */
const widening = (): JobDriver => {
  const inner = memoryJobDriver();
  return {
    ...inner,
    claim: (options) =>
      inner.claim(options.queues.length === 0 ? { ...options, queues: ['default'] } : options),
  };
};

describe('the empty queue list check', () => {
  test('fails a driver that answers an empty queue list, and passes one that refuses it', async () => {
    if (emptyQueues === undefined) return expect.unreachable('the check exists');
    let verdict: unknown = 'passed';
    try {
      await emptyQueues.run(widening());
    } catch (error) {
      verdict = error;
    }
    // The widened claim resolved, so the check's own verdict on the refusal is what failed.
    expect(verdict).toBeInstanceOf(Error);
    expect(String(verdict)).toContain('toMatchObject');
    await emptyQueues.run(memoryJobDriver());
  });
});
