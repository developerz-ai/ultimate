// The two queue gauges an alert can actually be written against. `queue_depth` and `jobs_total`
// live in `@ultimat3/core`'s `runtime-metrics.ts` because the deploy chart scales on them; these
// two are not scaling signals, they are the ones every queue team pages on, and neither existed:
//
//   "page if the oldest job in payments is older than 5 minutes" — no series carried
//     `oldestReadyMs`, which `QueueStats` computes, `inspectQueues` renders and nothing published.
//     `queue_depth` cannot tell 10 jobs stuck for an hour from 10 enqueued a second ago.
//   "page if the dead-letter queue is not empty" — `jobs_total{outcome="dead"}` is a COUNTER, so
//     a DLQ that filled overnight and stopped growing has a flat rate and alerts on nothing.
//
// Declared here rather than in core because they are this package's facts and core is another
// package's file; if they move next to `queueDepth` later, these two functions are the only
// callers to redirect.

import type { Gauge } from '@ultimat3/core';
import { gauge } from '@ultimat3/core';

/** Seconds and not milliseconds: every Prometheus duration is seconds, and the alert is `> 300`. */
export const queueOldestReady: Gauge = gauge('queue_oldest_ready_seconds', {
  unit: 's',
  description: 'Age of the oldest claimable job, by queue — 0 when the queue is empty',
});

export const queueDeadJobs: Gauge = gauge('queue_dead_jobs', {
  unit: '{job}',
  description: 'Jobs sitting in the dead-letter state, by queue',
});

export function recordQueueOldestReady(queue: string, oldestReadyMs: number): void {
  queueOldestReady.record(oldestReadyMs / 1000, { queue });
}

export function recordQueueDeadJobs(queue: string, dead: number): void {
  queueDeadJobs.record(dead, { queue });
}
