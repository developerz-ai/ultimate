// One occurrence of one task, dispatched: its job requests built, then queued together with the
// watermark in ONE step (`SchedulerState.fire`). Apart from `scheduler.ts` because that file is the
// round — which occurrences are owed, under which lease — and this is what firing one of them is.

import { logger } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { signalEnqueued } from './enqueue-signal';
import { instrumentedFire } from './job-instrument';
import { enqueuedAttempts } from './retry';
import type { SchedulerState } from './scheduler-state';
import type { TaskHandle, TaskJobResult } from './task';

export interface DispatchedOccurrence {
  readonly task: string;
  readonly occurrenceMs: number;
  readonly jobs: readonly TaskJobResult[];
  readonly catchUp: boolean;
}

export interface DispatchTarget {
  readonly driver: JobDriver;
  readonly state: SchedulerState;
  /**
   * Called once the requests are built and the fire is about to be attempted — the first point
   * the watermark may move. A throw BEFORE it (the task's `enqueue`, a key refusal) wrote nothing,
   * so what the round remembers of the watermark is still true and is not read again.
   */
  readonly firing: (taskName: string) => void;
}

export async function dispatchOccurrence(
  target: DispatchTarget,
  handle: TaskHandle,
  occurrenceMs: number,
  catchUp: boolean,
  watermarkMs?: number,
): Promise<DispatchedOccurrence | undefined> {
  // The occurrence, not `at`: a catch-up dispatch runs long after the instant it fires for,
  // and the payload has to describe the occurrence the email/report claims to be about.
  const requests = handle.entries(occurrenceMs).map(([handleForJob, input]) => {
    // The facade's refusal, at the one enqueue that does not go through it: an empty key.
    handleForJob.concurrencyKeyFor(input);
    return {
      name: handleForJob.name,
      queue: handleForJob.queue,
      input,
      // Occurrence-scoped key: belt to the watermark's braces across a deploy that still has
      // the old two-step fire in flight.
      idempotencyKey: `${handle.name}:${occurrenceMs}:${handleForJob.idempotencyKeyFor(input)}`,
      maxAttempts: enqueuedAttempts(handleForJob.retry, handleForJob.compensates),
      runAt: occurrenceMs,
    };
  });
  target.firing(handle.name);
  // Jobs and watermark in ONE step (`SchedulerState.fire`). `undefined` is an occurrence some
  // other dispatcher already fired: nothing was queued, and nothing is reported as dispatched.
  // Under the fire's producer span, which stamps each request's `traceparent` (`job-instrument.ts`).
  const results = await instrumentedFire(handle.name, requests, (jobs) =>
    target.state.fire(target.driver, {
      task: handle.name,
      occurrenceMs,
      ...(watermarkMs === undefined ? {} : { watermarkMs }),
      jobs,
    }),
  );
  if (results === undefined) {
    logger.info('jobs.scheduler.already-fired', {
      task: handle.name,
      occurrence: new Date(occurrenceMs).toISOString(),
    });
    return undefined;
  }
  // A worker in this process that has backed off starts its next pass now.
  signalEnqueued();
  const jobs: TaskJobResult[] = requests.map((request, index) => ({
    job: request.name,
    result: results[index] ?? { id: '', runId: '', deduped: true },
  }));
  // An on-time fire is routine, one line per task per occurrence (88% of a scheduler pod's
  // lines in production): `debug`, as the sibling per-unit events are. A catch-up is news.
  const occurrence = new Date(occurrenceMs).toISOString();
  const fields = { task: handle.name, occurrence, tz: handle.tz, catchUp, jobs: jobs.length };
  // info: a catch-up fire is a rare outcome — the scheduler was down or behind for an occurrence.
  if (catchUp) logger.info('jobs.scheduler.dispatched', fields);
  else logger.debug('jobs.scheduler.dispatched', fields);
  return { task: handle.name, occurrenceMs, jobs, catchUp };
}
