// `pollEvery`: the poll value `useQuery` starts. The timer is core's `visibleInterval`, tested there;
// pinned here is that `start` runs on the period it was given, and stops through its disposer.

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

  test('runs on the period it was given, not before', async () => {
    jest.useFakeTimers();
    let runs = 0;
    const stop = pollEvery(250).start(async () => {
      runs += 1;
    });
    jest.advanceTimersByTime(249);
    expect(runs).toBe(0);
    jest.advanceTimersByTime(1);
    expect(runs).toBe(1);
    stop();
  });

  test('a non-finite period is refused when it starts', () => {
    try {
      pollEvery(Number.NaN).start(async () => undefined);
      expect.unreachable('a NaN period was accepted');
    } catch (error) {
      expect(isUltimateError(error)).toBe(true);
    }
  });
});
