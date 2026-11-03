// The run's deadline as a timer. `setTimeout` keeps 32 bits: a delay above 2^31 - 1 ms fires at about
// 1 ms, so a job declaring a long `timeout` was cancelled and failed the moment it started.

import { describe, expect, test } from 'bun:test';
import { MAX_TIMER_MS } from '@ultimat3/core';
import { raceTimeout } from './run-deadline';

/** A delay past 32 bits fires at ~1 ms, so these turns, armed after it, run after it too. */
const pastAnOverflowedTimer = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((done) => setTimeout(done, 1));
};

describe('raceTimeout', () => {
  test('a timeout past the timer limit does not fire at once', async () => {
    const cancel = new AbortController();
    const answer = await raceTimeout(
      pastAnOverflowedTimer().then(() => 'done'),
      MAX_TIMER_MS + 1,
      'long-job',
      cancel,
    );
    expect(answer).toBe('done');
    expect(cancel.signal.aborted).toBe(false);
  });

  test('a short timeout still cancels, then rejects', async () => {
    const cancel = new AbortController();
    const race = raceTimeout(new Promise(() => undefined), 5, 'short-job', cancel);
    await expect(race).rejects.toBeUltimateError('X_JOB_TIMEOUT');
    expect(cancel.signal.aborted).toBe(true);
  });
});
