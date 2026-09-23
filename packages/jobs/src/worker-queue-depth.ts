// Single responsibility: the worker's queue metrics — `queue_depth` and the two gauges beside it —
// republished on their own interval. Split from `worker.ts` at the file-size ceiling; nothing here
// closes over the claim loop, only over the driver, the clock and the worker's id.

import type { Clock } from '@ultimat3/core';
import { logger, recordQueueDepth, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobDriver } from './driver';
import { recordQueueDeadJobs, recordQueueOldestReady } from './metrics';

/**
 * How often the claim loop republishes `queue_depth`. Its own interval, not `pollIntervalMs`:
 * `driver.stats()` is an aggregate over the whole jobs table and a scrape reads the gauge every
 * ~15s, so publishing at the poll rate would multiply the queue's read load by sixty to write the
 * same number sixty times.
 */
const QUEUE_DEPTH_INTERVAL_MS = 15_000;

/**
 * This package's ONE metrics call site: the `queue_depth` series `docker/helm`'s worker HPA
 * scales on. `ready` and not `ready + delayed` — the gauge means "waiting to be picked up", and
 * a job parked until Tuesday is not backlog no matter how many workers are added. `ready` counts
 * every DUE row, a delayed one past its `run_at` included (`SQL_STATS`). Every queue the driver
 * reports, not only the ones this process serves, because depth is the queue's fact and a queue
 * no pod published is a queue no autoscaler can see.
 *
 * So every worker pod publishes the SAME number, and a reader must treat it as one series for
 * the whole fleet: deduplicate with `max`, never `sum`. The chart's worker HPA reads it as an
 * `External` metric with an `AverageValue` target, which divides it by the replica count; read
 * as a `Pods` metric it was averaged as if each pod held the whole backlog, and the autoscaler
 * asked for N times the workers the queue needed until it hit `maxReplicas`.
 */
export function createQueueDepthPublisher(input: {
  readonly driver: JobDriver;
  readonly clock: Clock | undefined;
  readonly workerId: string;
}): () => Promise<void> {
  let publishedAt = Number.NEGATIVE_INFINITY;
  return async (): Promise<void> => {
    const now = nowMs(input.clock);
    if (now - publishedAt < QUEUE_DEPTH_INTERVAL_MS) return;
    publishedAt = now;
    try {
      for (const stat of await input.driver.stats()) {
        recordQueueDepth(stat.queue, stat.ready);
        // Depth alone is not alertable: it cannot tell "10 jobs stuck for an hour" from "10 jobs
        // enqueued a second ago", and `jobs_total{outcome="dead"}` is a rate, so a dead-letter
        // queue that filled overnight and stopped growing pages nobody. Both numbers are already
        // in `stats()` — this queries nothing new.
        recordQueueOldestReady(stat.queue, stat.oldestReadyMs);
        recordQueueDeadJobs(stat.queue, stat.dead);
      }
    } catch (error) {
      // Instrumentation never costs a tick: a queue that cannot be measured must still be worked.
      logger.warn('jobs.worker.depth-failed', {
        workerId: input.workerId,
        error: renderThrowable(error),
      });
    }
  };
}
