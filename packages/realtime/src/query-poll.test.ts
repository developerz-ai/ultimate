// `pollEvery`: the poll value `useQuery` starts. The timer is core's `visibleInterval`, tested there;
// pinned here is that the value carries its period and that `start` runs and stops through it.

import { afterEach, describe, expect, jest, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { pollEvery } from './query-poll';

afterEach(() => {
  jest.useRealTimers();
});

describe('pollEvery', () => {
  test('runs every period until its disposer is called', async () => {
    jest.useFakeTimers();
    let runs = 0;
    const stop = pollEvery(500).start(async () => {
      runs += 1;
    });
    jest.advanceTimersByTime(500);
    await Promise.resolve();
    jest.advanceTimersByTime(500);
    expect(runs).toBe(2);
    stop();
    jest.advanceTimersByTime(5_000);
    expect(runs).toBe(2);
  });

  test('carries its period, and a non-finite one is refused when it starts', () => {
    expect(pollEvery(250).ms).toBe(250);
    try {
      pollEvery(Number.NaN).start(async () => undefined);
      expect.unreachable('a NaN period was accepted');
    } catch (error) {
      expect(isUltimateError(error)).toBe(true);
    }
  });
});
