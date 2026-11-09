// A `compensates: true` job is enqueued with `UNWIND_MARGIN` attempts past its policy, on every
// path a row is written by — a direct enqueue, a staged one, the scheduler's — so the claim can
// re-offer a final attempt that crashed. A job without it is enqueued exactly as before.

import { afterEach, describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { installJobDriver, resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { directRequest, stagedRecord } from './enqueue-record';
import { job, resetJobs } from './job';
import { enqueuedAttempts, isFinalAttempt, isUnwindAttempt, UNWIND_MARGIN } from './retry';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

const declare = (compensates: boolean) =>
  job<{ id: string }>({
    name: compensates ? 'saga' : 'plain',
    tenant: 'none',
    input: t.object({ id: t.string }),
    idempotencyKey: ({ id }) => id,
    retry: { attempts: 4 },
    compensates,
    run: () => Promise.resolve(),
  });

describe('the unwind margin', () => {
  test('is on the row, never on the policy the body and the retry decision read', () => {
    expect(UNWIND_MARGIN).toBe(2);
    expect(enqueuedAttempts({ attempts: 4 }, true)).toBe(6);
    expect(enqueuedAttempts({ attempts: 4 }, false)).toBe(4);
    expect(isFinalAttempt({ attempts: 4 }, 4)).toBe(true);
    expect(isUnwindAttempt({ attempts: 4 }, 4)).toBe(false);
    expect(isUnwindAttempt({ attempts: 4 }, 5)).toBe(true);
  });

  test('a direct and a staged enqueue both carry it', () => {
    const facts = { idempotencyKey: 'k', at: 0, trace: undefined };
    for (const [compensates, attempts] of [
      [true, 6],
      [false, 4],
    ] as const) {
      const handle = declare(compensates);
      expect(directRequest(handle, { id: 'a' }, {}, facts).maxAttempts).toBe(attempts);
      expect(
        stagedRecord(handle, { id: 'a' }, {}, { ...facts, id: 'i', runId: 'r' }).maxAttempts,
      ).toBe(attempts);
      resetJobs();
    }
  });

  test('handle.enqueue writes the row with it', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    await declare(true).enqueue({ id: 'o-1' });
    expect((await driver.introspect?.list())?.[0]?.maxAttempts).toBe(6);
  });
});
