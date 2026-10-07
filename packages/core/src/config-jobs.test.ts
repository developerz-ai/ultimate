// `jobs.concurrency` as a number for every queue a worker serves, or a table of slots per queue
// (issue #676): one process serving `banks` and `banks-long` gives them 4 and 2, from the config.

import { describe, expect, test } from 'bun:test';
import { defineConfig } from './config';
import { JOBS_CONCURRENCY_DEFAULT } from './config-jobs';
import { isUltimateError } from './errors';

/** The refusal's `cause`, or a verdict naming that nothing was refused. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_CONFIG_INVALID') return error.cause;
    throw error;
  }
  return expect.unreachable('defineConfig accepted the value');
}

describe('jobs.concurrency', () => {
  test('a table of slots per queue is kept as written', () => {
    const config = defineConfig({
      name: 'bank',
      jobs: { queues: ['banks', 'banks-long'], concurrency: { banks: 4, 'banks-long': 2 } },
    });
    expect(config.jobs.concurrency).toEqual({ banks: 4, 'banks-long': 2 });
  });

  test('an overlay replaces the table whole, never merges into it', () => {
    const config = defineConfig(
      { name: 'bank', jobs: { concurrency: { banks: 4, 'banks-long': 2 } } },
      { jobs: { concurrency: { banks: 1 } } },
    );
    expect(config.jobs.concurrency).toEqual({ banks: 1 });
  });

  test('the number form is unchanged, and its default is the exported one', () => {
    expect(defineConfig({ name: 'bank' }).jobs.concurrency).toBe(JOBS_CONCURRENCY_DEFAULT);
    expect(defineConfig({ name: 'bank', jobs: { concurrency: 3 } }).jobs.concurrency).toBe(3);
  });

  test('a slot count in the table is refused by its own path', () => {
    const cause = refusal(() =>
      defineConfig({ name: 'bank', jobs: { concurrency: { banks: 0, 'banks-long': 2.5 } } }),
    );
    expect(cause).toContain('jobs.concurrency.banks must be a whole number of at least 1, not 0');
    expect(cause).toContain('jobs.concurrency.banks-long must be a whole number of at least 1');
  });

  test('an empty table names no queue, and is refused rather than read as every default', () => {
    expect(refusal(() => defineConfig({ name: 'bank', jobs: { concurrency: {} } }))).toContain(
      'jobs.concurrency must name at least one queue',
    );
  });

  test('a blank queue name is refused', () => {
    expect(
      refusal(() => defineConfig({ name: 'bank', jobs: { concurrency: { ' ': 2 } } })),
    ).toContain('jobs.concurrency names " ", not a queue');
  });

  test('neither a number nor a table is refused by shape', () => {
    const list = refusal(() =>
      defineConfig({ name: 'bank', jobs: { concurrency: [4, 2] as never } }),
    );
    expect(list).toContain('jobs.concurrency must be a whole number of at least 1');
    expect(list).toContain('or a table of slots per queue');
  });
});
