// Single responsibility: the drain budget's domain and its one default — the config validator and
// the lifecycle must agree on both, or `app.config.ts` accepts a budget the process never runs.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  DRAIN_DEADLINE_DEFAULT_MS,
  DRAIN_DEADLINE_MAX_MS,
  drainDeadlineIssue,
} from './drain-deadline';
import { drainDeadlineMs, resetLifecycle } from './lifecycle';

afterEach(() => {
  resetLifecycle();
});

describe('the drain budget', () => {
  test('the lifecycle drains in the config default when nothing configured it', () => {
    expect(DRAIN_DEADLINE_DEFAULT_MS).toBe(25_000);
    expect(drainDeadlineMs()).toBe(DRAIN_DEADLINE_DEFAULT_MS);
  });

  test('accepts 1 ms through the bound, inclusive', () => {
    for (const ok of [1, 25_000, DRAIN_DEADLINE_MAX_MS]) {
      expect(drainDeadlineIssue(ok)).toBeUndefined();
    }
  });

  test('refuses what is not a whole positive number of milliseconds within the bound', () => {
    for (const bad of [
      0,
      -1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      DRAIN_DEADLINE_MAX_MS + 1,
    ]) {
      expect(drainDeadlineIssue(bad)).toContain('drain.deadlineMs');
    }
    expect(drainDeadlineIssue('25000')).toContain('drain.deadlineMs');
    expect(drainDeadlineIssue(undefined)).toContain('drain.deadlineMs');
  });

  test('the over-bound refusal says why rather than only the number', () => {
    expect(drainDeadlineIssue(DRAIN_DEADLINE_MAX_MS + 1)).toContain('at most 3600000');
  });
});
