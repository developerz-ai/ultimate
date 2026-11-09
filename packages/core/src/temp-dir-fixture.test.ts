// `removeTempDir`'s Windows branch, proven on Linux: the held-open answers are faked, the sleeps
// recorded instead of slept.

import { describe, expect, test } from 'bun:test';
import { REMOVE_ATTEMPTS, removeTempDir } from './temp-dir-fixture';

const errnoError = (code: string): Error => Object.assign(new Error(code), { code });

/** Throws `codes` in order, then removes; records every sleep it was asked for. */
const heldFor = (codes: readonly string[]) => {
  const pending = [...codes];
  const slept: number[] = [];
  let removed = 0;
  const io = {
    remove: (): void => {
      const code = pending.shift();
      if (code !== undefined) throw errnoError(code);
      removed++;
    },
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { io, slept, removed: () => removed };
};

describe('removeTempDir', () => {
  test('a directory held open (EBUSY, EPERM) is retried with a growing backoff, then removed', async () => {
    const held = heldFor(['EBUSY', 'EPERM', 'EBUSY']);
    await removeTempDir('/tmp/x', held.io);
    expect(held.removed()).toBe(1);
    expect(held.slept).toEqual([50, 100, 200]);
  });

  test('a directory free at once is removed with no wait', async () => {
    const held = heldFor([]);
    await removeTempDir('/tmp/x', held.io);
    expect(held.removed()).toBe(1);
    expect(held.slept).toEqual([]);
  });

  test('the wait is bounded: the last EBUSY is thrown after REMOVE_ATTEMPTS tries', async () => {
    const held = heldFor(Array.from({ length: REMOVE_ATTEMPTS }, () => 'EBUSY'));
    await expect(removeTempDir('/tmp/x', held.io)).rejects.toThrow('EBUSY');
    expect(held.slept).toHaveLength(REMOVE_ATTEMPTS - 1);
    expect(held.removed()).toBe(0);
  });

  test('any other failure is thrown at once, never waited on', async () => {
    const held = heldFor(['EACCES']);
    await expect(removeTempDir('/tmp/x', held.io)).rejects.toThrow('EACCES');
    expect(held.slept).toEqual([]);
  });
});
