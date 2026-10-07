// The scheduler's durable seam: the watermark it decides "missed" against, and the ONE operation
// that moves it together with the jobs an occurrence queues. Apart from `scheduler.ts` because
// that file is the dispatch round and the drain; this is the contract a store implements
// (`scheduler-pg.ts` in production, the memory one here).

import type { EnqueueRequest, EnqueueResult, JobDriver } from './driver';

/** One occurrence of one task, and every job it queues. */
export interface ScheduledFire {
  readonly task: string;
  readonly occurrenceMs: number;
  /**
   * Where the watermark LANDS, when that is past the occurrence: `run-once` runs the earliest
   * missed occurrence and drops the rest, and dropping is moving the watermark past them — in the
   * same write, or a crash between the two fires a second "one catch-up". The fence is still the
   * occurrence. Omitted, the watermark lands on the occurrence.
   */
  readonly watermarkMs?: number;
  readonly jobs: readonly EnqueueRequest[];
}

export interface SchedulerState {
  /** Epoch ms of the last occurrence this task was dispatched for. */
  lastFiredAt(taskName: string): Promise<number | undefined>;
  /** Move the watermark WITHOUT firing: arming a task first seen, or dropping missed occurrences. */
  markFired(taskName: string, occurrenceMs: number): Promise<void>;
  /**
   * Queue every job of one occurrence and move the watermark onto it — both, or neither. One
   * result per job, in order. `undefined` when the watermark is already at or past this
   * occurrence: another dispatcher fired it, and nothing is queued.
   *
   * It was `driver.enqueue` per job and then `markFired`. Anything between the two left the
   * watermark behind jobs already queued, the next round fired the occurrence again, and the
   * occurrence-scoped idempotency key absorbs that only while the first job is still LIVE.
   */
  fire(driver: JobDriver, fire: ScheduledFire): Promise<readonly EnqueueResult[] | undefined>;
}

/**
 * The fire for a store that cannot share a statement with the queue: the watermark is checked,
 * the jobs go through `driver.enqueue`, and the watermark moves last. Not atomic across a crash —
 * which is why `postgresSchedulerState` does not use it against the pg driver — but exact for the
 * memory pair, where nothing can fail between the steps and no second process exists.
 */
export async function fireThroughDriver(
  state: Pick<SchedulerState, 'lastFiredAt' | 'markFired'>,
  driver: JobDriver,
  fire: ScheduledFire,
): Promise<readonly EnqueueResult[] | undefined> {
  const last = await state.lastFiredAt(fire.task);
  if (last !== undefined && last >= fire.occurrenceMs) return undefined;
  const results: EnqueueResult[] = [];
  for (const request of fire.jobs) results.push(await driver.enqueue(request));
  await state.markFired(fire.task, fire.watermarkMs ?? fire.occurrenceMs);
  // What an operator reads as "last fired". After the watermark, so a record never names an
  // occurrence a crash would fire again.
  await driver.introspect?.recordTaskFire({ task: fire.task, occurrenceMs: fire.occurrenceMs });
  return results;
}

export function memorySchedulerState(): SchedulerState {
  const fired = new Map<string, number>();
  const state: SchedulerState = {
    lastFiredAt: (taskName) => Promise.resolve(fired.get(taskName)),
    markFired(taskName, occurrenceMs) {
      // Forward only, as `SQL_SCHEDULER_STATE_MARK`'s `greatest` is: a mark never rewinds.
      fired.set(taskName, Math.max(fired.get(taskName) ?? occurrenceMs, occurrenceMs));
      return Promise.resolve();
    },
    fire: (driver, fire) => fireThroughDriver(state, driver, fire),
  };
  return state;
}
