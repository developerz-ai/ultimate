// `retry.attempts` is a COUNT, and reaches Postgres as `$7::int` (`x_jobs.max_attempts`). The
// backstop read `>= 1` alone, so `Infinity` and `1.5` were declared without complaint, ran on the
// memory driver, and failed the first enqueue in production with a raw cast error.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { job, resetJobs } from './job';

const passthrough: StandardSchemaV1<unknown, { readonly id: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as { readonly id: string } }),
  },
};

let minted = 0;

const declare = (attempts: unknown): unknown => {
  minted += 1;
  try {
    return job<{ readonly id: string }>({
      tenant: 'none',
      name: `attempts-${minted}`,
      input: passthrough,
      idempotencyKey: ({ id }) => `attempts:${id}`,
      // The cast is the test: a JS caller, or generated code, hands over whatever it has.
      retry: { attempts: attempts as number },
      run: () => Promise.resolve(),
    });
  } catch (error) {
    return error;
  }
};

afterEach(() => {
  resetJobs();
});

describe('job() takes retry.attempts as a whole number of at least 1', () => {
  test('zero, a negative, a fraction, NaN and both infinities are refused at declaration', () => {
    for (const attempts of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
    ]) {
      const refusal = declare(attempts);
      if (!isUltimateError(refusal)) {
        return expect.unreachable(`retry.attempts ${String(attempts)} was accepted`);
      }
      expect(refusal.code).toBe('X_INVARIANT');
      expect(String(refusal.cause)).toContain(`job "attempts-${minted}" retry.attempts is`);
      expect(String(refusal.cause)).toContain('at least 1');
    }
  });

  test('a value that is not a number at all is the same coded refusal, never a TypeError', () => {
    for (const attempts of ['3', null, undefined, {}, true]) {
      const refusal = declare(attempts);
      if (!isUltimateError(refusal)) {
        return expect.unreachable(`retry.attempts ${JSON.stringify(attempts)} was accepted`);
      }
      expect(refusal.code).toBe('X_INVARIANT');
    }
  });

  test('one and a real count are declared as written', () => {
    for (const attempts of [1, 3, 25]) {
      const handle = declare(attempts);
      if (isUltimateError(handle)) return expect.unreachable(String(handle.cause));
      expect(handle).toMatchObject({ retry: { attempts } });
    }
  });
});
