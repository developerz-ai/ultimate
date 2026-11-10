// `retry.jitter` is refused at `job()` unless it is core's `JitterMode`: a v30 boolean arriving from
// JS or JSON config otherwise meant "no jitter" to the backoff and "jitter" to a stated delay.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { job, resetJobs } from './job';

afterEach(() => {
  resetJobs();
});

const declare =
  (jitter: unknown, name = 'jittered') =>
  () =>
    job({
      tenant: 'none',
      name,
      input: t.object({ id: t.string }),
      idempotencyKey: ({ id }) => id,
      // The type forbids it; generated code and JS callers are how a boolean still arrives.
      retry: { attempts: 3, jitter } as unknown as { attempts: number },
      run: () => Promise.resolve(),
    });

function refusal(jitter: unknown): unknown {
  try {
    declare(jitter)();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('retry.jitter at declaration', () => {
  test.each(['none', 'equal', 'full', undefined])('%p is accepted', (jitter) => {
    expect(declare(jitter, `ok-${String(jitter)}`)).not.toThrow();
  });

  test.each([
    [true, "'equal'"],
    [false, "'none'"],
  ])('a v30 boolean %p is refused, and the fix names %s', (jitter, mapped) => {
    const error = refusal(jitter);
    expect(isUltimateError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'X_JOB_DECLARATION_INVALID' });
    const fix = (error as { fix: string }).fix;
    expect(fix).toContain(`jitter: ${mapped}`);
    expect(fix).toContain("true → 'equal'");
    expect(fix).toContain("false → 'none'");
  });

  test.each(['random', 1, null])('any other value %p is refused too', (jitter) => {
    expect(refusal(jitter)).toMatchObject({ code: 'X_JOB_DECLARATION_INVALID' });
  });
});
