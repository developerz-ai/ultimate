// `job({ maxPending })`: refuse a producer while its queue is drowning, before anything is written.
// The facade asks once per enqueue, on both paths, and only for a job that declared the ceiling —
// one capped count (`JobDriver.backlog`), never a pass over the backlog it is protecting.

import { assert, renderFixShellArg, UltimateError } from '@ultimat3/core';
import type { JobDriver } from './driver';

/** An enqueue that would put the queue past the job's declared `maxPending`. A 429. */
export class JobBacklogFullError extends UltimateError {
  constructor(input: { job: string; queue: string; maxPending: number; adding: number }) {
    super({
      code: 'X_JOB_BACKLOG_FULL',
      cause: `job "${input.job}" declares maxPending ${input.maxPending}, and queue "${input.queue}" already holds that many rows waiting to run — ${input.adding} more were refused before any was written`,
      fix: `x jobs list --queue ${renderFixShellArg(input.queue, '<the queue the cause names>')} --json   # the depth; retry this enqueue after a backoff, add workers for "${input.queue}", or raise maxPending on job("${input.job}")`,
      meta: { job: input.job, queue: input.queue, maxPending: input.maxPending },
    });
  }
}

/**
 * Refuse `adding` more rows of `job` onto `queue` when they would cross its `maxPending`. A no-op
 * for a job that declared none. Counted before the write and not inside it: the staged path's
 * insert happens after commit, in the relay, where nobody is left to refuse.
 */
export async function refuseBacklog(
  driver: Pick<JobDriver, 'name' | 'backlog'>,
  job: { readonly name: string; readonly maxPending: number | undefined },
  queue: string,
  adding: number,
): Promise<void> {
  const max = job.maxPending;
  if (max === undefined) return;
  assert(
    driver.backlog !== undefined,
    `job "${job.name}" declares maxPending, and the ${driver.name} job driver counts no backlog (JobDriver.backlog), so the ceiling would hold nothing`,
    `postgresJobDriver()   # or memoryJobDriver() / redisJobDriver() — the drivers that count one — in apps/<app>/runtime.ts, or drop maxPending from job("${job.name}")`,
  );
  const waiting = await driver.backlog(queue, max);
  if (waiting + adding > max) {
    throw new JobBacklogFullError({ job: job.name, queue, maxPending: max, adding });
  }
}
