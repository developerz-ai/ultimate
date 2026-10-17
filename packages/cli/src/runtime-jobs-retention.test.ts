// The three job windows the boot builds its `x_jobs` and `x_outbox` targets with: read off a
// `defineConfig` result, defaulted for a boot with no config or a hand-built one that left the
// optional keys out, and refused when a number is not a window. The statements those targets send
// are `@ultimat3/jobs`' own `.job.` suites; this is the wiring.

import { describe, expect, test } from 'bun:test';
import type { AppConfig, PgExecutor } from '@ultimat3/core';
import {
  defineConfig,
  JOBS_DEAD_RETENTION_MS_DEFAULT,
  JOBS_DONE_RETENTION_MS_DEFAULT,
  JOBS_OUTBOX_RETENTION_MS_DEFAULT,
} from '@ultimat3/core';
import { jobsRetentionOf, jobsRetentionTargets } from './runtime-jobs-retention';

const DAY_MS = 86_400_000;
const DEFAULTS = {
  doneRetentionMs: JOBS_DONE_RETENTION_MS_DEFAULT,
  deadRetentionMs: JOBS_DEAD_RETENTION_MS_DEFAULT,
  outboxRetentionMs: JOBS_OUTBOX_RETENTION_MS_DEFAULT,
};

/** `config` with its `jobs` section replaced AS WRITTEN — what no `defineConfig` would answer. */
const withJobs = (jobs: Record<string, unknown>): AppConfig => {
  const config = defineConfig({ name: 'demo' });
  return { ...config, jobs: { ...config.jobs, ...jobs } } as AppConfig;
};

describe('jobsRetentionOf', () => {
  test('a boot with no config file keeps finished rows exactly as long as one that wrote no key', () => {
    expect(jobsRetentionOf(undefined)).toEqual(DEFAULTS);
    expect(jobsRetentionOf(defineConfig({ name: 'demo' }))).toEqual(DEFAULTS);
  });

  test('reads each window the app set, and leaves the others at their defaults', () => {
    const config = defineConfig({
      name: 'demo',
      jobs: { doneRetentionMs: DAY_MS, outboxRetentionMs: 2 * DAY_MS },
    });
    expect(jobsRetentionOf(config)).toEqual({
      ...DEFAULTS,
      doneRetentionMs: DAY_MS,
      outboxRetentionMs: 2 * DAY_MS,
    });
  });

  test('a hand-built config that left the optional keys out resolves to the defaults', () => {
    const config = withJobs({
      doneRetentionMs: undefined,
      deadRetentionMs: undefined,
      outboxRetentionMs: undefined,
    });
    expect(jobsRetentionOf(config)).toEqual(DEFAULTS);
  });

  test('a window that is not a whole positive number is refused by name, never swept with', () => {
    for (const key of ['doneRetentionMs', 'deadRetentionMs', 'outboxRetentionMs'] as const) {
      for (const bad of [Number.NaN, 0, 1.5, Number.POSITIVE_INFINITY]) {
        expect(() => jobsRetentionOf(withJobs({ [key]: bad })), `${key} ${String(bad)}`).toThrow(
          new RegExp(`jobs\\.${key}`),
        );
      }
    }
  });
});

describe('jobsRetentionTargets', () => {
  test('answers the x_jobs and x_outbox targets over the boot’s own executor', async () => {
    const sent: string[] = [];
    const executor: PgExecutor = {
      query: <R>(text: string): Promise<readonly R[]> => {
        sent.push(text);
        return Promise.resolve([{ removed: 0, held: '[]' }] as unknown as readonly R[]);
      },
    };
    const targets = jobsRetentionTargets(executor, undefined);
    expect([targets.jobs.name, targets.outbox.name]).toEqual(['x_jobs', 'x_outbox']);
    expect(await targets.jobs.purgeExpired(Date.now())).toBe(0);
    expect(await targets.outbox.purgeExpired(Date.now())).toBe(0);
    expect(sent.map((text) => /delete from (\w+)/.exec(text)?.[1])).toEqual(['x_jobs', 'x_outbox']);
  });
});
