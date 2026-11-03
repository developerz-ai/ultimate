// `lock_timeout` firing is a turn lost, not a refusal: the blocker ends and the queue behind the
// ALTER has to drain. These pin the loop's arithmetic; `migrate-lock-retry.live.test.ts` the point.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { DbClient } from './client';
import { DbError } from './errors';
import { type RecordingClient, recordingClient } from './fake';
import { migrate } from './migrate';
import { MIGRATION_LOCK_RETRIES, withLockRetry } from './migrate-lock-retry';

const timedOut = (): DbError =>
  new DbError({
    code: 'X_DB_LOCK_TIMEOUT',
    cause: 'canceling statement due to lock timeout',
    fix: 'x doctor --json',
  });

const seams = () => {
  const waits: number[] = [];
  return {
    waits,
    policy: {
      lockTimeoutMs: 3000,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      random: () => 0.5,
    },
  };
};

describe('withLockRetry', () => {
  test('retries the step after a lock timeout and returns its success', async () => {
    const { waits, policy } = seams();
    let attempts = 0;
    await withLockRetry('m1', { ...policy, retries: 2 }, async () => {
      attempts += 1;
      if (attempts === 1) throw timedOut();
    });
    expect(attempts).toBe(2);
    expect(waits.length).toBe(1);
  });

  test('every wait is at least one lock timeout, so the queue behind the ALTER drains', async () => {
    const { waits, policy } = seams();
    await withLockRetry('m1', { ...policy, retries: 3, random: () => 0 }, async () => {
      if (waits.length < 3) throw timedOut();
    });
    expect(waits).toEqual([3000, 3000, 3000]);
  });

  test('jitter only ever lengthens the wait', async () => {
    const { waits, policy } = seams();
    await withLockRetry('m1', { ...policy, retries: 1, random: () => 0.999 }, async () => {
      if (waits.length < 1) throw timedOut();
    });
    expect(waits[0]).toBeGreaterThan(3000);
    expect(waits[0]).toBeLessThanOrEqual(4500);
  });

  test('exhausted is X_DB_LOCK_TIMEOUT, its cause stating the attempts', async () => {
    const { policy } = seams();
    let attempts = 0;
    let thrown: unknown;
    try {
      await withLockRetry('m1', { ...policy, retries: 2 }, async () => {
        attempts += 1;
        throw timedOut();
      });
    } catch (error) {
      thrown = error;
    }
    expect(attempts).toBe(3);
    expect(thrown).toBeInstanceOf(UltimateError);
    const error = thrown as UltimateError;
    expect(error.code).toBe('X_DB_LOCK_TIMEOUT');
    expect(error.cause).toContain('migration "m1"');
    expect(error.cause).toContain('3 attempts');
    expect(error.fix).toBe('x doctor --json');
  });

  test('any other failure is the first answer: no second attempt, no wait', async () => {
    const { waits, policy } = seams();
    let attempts = 0;
    const other = new DbError({ code: 'X_DB_DRIFT', cause: 'c', fix: 'x db migrate' });
    await expect(
      withLockRetry('m1', { ...policy, retries: 5 }, async () => {
        attempts += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  test('zero retries is one attempt', async () => {
    const { policy } = seams();
    let attempts = 0;
    await expect(
      withLockRetry('m1', { ...policy, retries: 0 }, async () => {
        attempts += 1;
        throw timedOut();
      }),
    ).rejects.toMatchObject({ code: 'X_DB_LOCK_TIMEOUT' });
    expect(attempts).toBe(1);
  });

  test('the default is five', () => {
    expect(MIGRATION_LOCK_RETRIES).toBe(5);
  });
});

describe('a -- transaction: false step retries the statement, never the step', () => {
  /** Answers `X_DB_LOCK_TIMEOUT` the first `times` sends of whichever statement `match` finds. */
  const lockedOn = (inner: RecordingClient, match: string, times: number): DbClient => {
    let left = times;
    return {
      ...inner,
      execute: async (fragment) => {
        if (fragment.text.includes(match) && left > 0) {
          left -= 1;
          throw timedOut();
        }
        return inner.execute(fragment);
      },
    };
  };
  const sends = (inner: RecordingClient, text: string): number =>
    inner.texts.filter((each) => each.includes(text)).length;
  const script = '-- transaction: false\nselect first_one;\nselect second_one;\nselect third_one;';
  const noWait = { sleep: async () => undefined, random: () => 0 };

  test('a timeout on the second statement does not send the first again', async () => {
    const inner = recordingClient();
    await migrate({
      migrations: [{ id: 'm1', name: 'm1', up: script, down: '' }],
      client: lockedOn(inner, 'second_one', 2),
      lockTimeoutMs: 1,
      lockRetries: 3,
      lockRetrySleep: noWait.sleep,
      lockRetryRandom: noWait.random,
      appVersion: 'test',
    });
    expect(sends(inner, 'first_one')).toBe(1);
    expect(sends(inner, 'second_one')).toBe(1);
    expect(sends(inner, 'third_one')).toBe(1);
    expect(sends(inner, 'insert into x_migrations')).toBe(1);
  });

  test('a transactional step still retries whole: its first attempt rolled back', async () => {
    const inner = recordingClient();
    await migrate({
      migrations: [{ id: 'm1', name: 'm1', up: 'select first_one;\nselect second_one;', down: '' }],
      client: lockedOn(inner, 'second_one', 1),
      lockTimeoutMs: 1,
      lockRetries: 3,
      lockRetrySleep: noWait.sleep,
      lockRetryRandom: noWait.random,
      appVersion: 'test',
    });
    expect(sends(inner, 'first_one')).toBe(2);
  });
});
