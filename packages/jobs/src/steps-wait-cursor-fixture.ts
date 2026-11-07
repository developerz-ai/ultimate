// A refused event, then a valid one in the SAME millisecond: the wait answers the valid one. The
// floor used to be `publishedAt + 1`, which stepped over it for good — `steps-wait-cursor*.test.ts`
// holds the memory bus and the Postgres one to that answer.

import { expect } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { EventBus } from './events';
import { isStepSuspension, stepRunner } from './steps';
import { memoryStepStore } from './steps-memory';

const Approval = t.object({ amount: t.number });

/**
 * Parks a wait, has `publishBoth` publish a refused payload then `{ amount: 12 }` in one ms, and
 * answers what the attempt after the refusal returns.
 */
export async function refusedThenValidSameMs(
  bus: EventBus,
  clock: Clock,
  publishBoth: () => Promise<void>,
): Promise<unknown> {
  const store = memoryStepStore();
  const attempt = () =>
    stepRunner({
      runId: 'run-cursor',
      jobName: 'pay',
      store,
      clock,
      events: bus,
    }).step.waitForEvent('approval', 'invoice.approved', { schema: Approval, timeout: '1h' });
  expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
  await publishBoth();
  const refused = await attempt().catch((error: unknown) => error);
  if (!isUltimateError(refused)) return expect.unreachable('expected X_JOB_EVENT_INVALID');
  expect(refused.code).toBe('X_JOB_EVENT_INVALID');
  return attempt().catch((error: unknown) => error);
}
