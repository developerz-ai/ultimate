// Single responsibility: `x jobs show`'s input under `.sensitive()` — masked by the job's own
// schema, and hidden WHOLE when the job's declaration is gone. WHY: a stored payload outlives the
// deploy that declared it, and with no schema nothing can say which of its keys are sensitive.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { REDACTED } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { resetJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { inspectJob } from './inspect';
import { job, resetJobs } from './job';
import { resetTasks } from './task';

const PAN = '4111111111111111';

beforeEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

afterEach(() => {
  resetJobs();
  resetTasks();
  resetJobDriver();
});

async function stored(name: string, input: unknown): Promise<unknown> {
  const driver = memoryJobDriver();
  const { id } = await driver.enqueue({
    name,
    queue: 'default',
    input,
    idempotencyKey: `${name}:1`,
    maxAttempts: 1,
  });
  return (await inspectJob(driver, id))?.input;
}

describe('inspectJob input', () => {
  test('a .sensitive() field is [redacted]; its neighbours and other jobs are not', async () => {
    job({
      tenant: 'none',
      name: 'chargeCard',
      input: t.object({ cardPan: t.string.sensitive(), note: t.string }),
      idempotencyKey: ({ note }) => note,
      retry: { attempts: 1, backoff: 'linear', delay: 1_000 },
      run: () => Promise.resolve(),
    });
    job({
      tenant: 'none',
      name: 'echoCard',
      input: t.object({ cardPan: t.string, note: t.string }),
      idempotencyKey: ({ note }) => note,
      retry: { attempts: 1, backoff: 'linear', delay: 1_000 },
      run: () => Promise.resolve(),
    });
    expect(await stored('chargeCard', { cardPan: PAN, note: 'n' })).toEqual({
      cardPan: REDACTED,
      note: 'n',
    });
    expect(await stored('echoCard', { cardPan: PAN, note: 'n' })).toEqual({
      cardPan: PAN,
      note: 'n',
    });
  });

  test('a job whose declaration is gone answers its input [redacted] whole', async () => {
    expect(await stored('retiredJob', { cardPan: PAN })).toBe(REDACTED);
  });
});
