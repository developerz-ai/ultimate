// An exact worker's (`WORKER_QUEUES`) one boot line about the registered queues it leaves: warned
// only for those NO live worker in the registry serves. Another Deployment serving the rest is the
// whole point of the split, and a warning at every boot of a correct fleet is noise that hides the
// one boot where a queue really has no worker.

import { logger, renderThrowable } from '@ultimat3/core';
import type { WorkerRecord } from '@ultimat3/jobs';

export interface UnservedQueuesInput {
  /** What this worker claims. */
  readonly served: readonly string[];
  /** Every queue a registered job is enqueued on. */
  readonly registered: readonly string[];
  /** The fleet's live rows (`introspect.workers`); `undefined` on a driver with no registry. */
  readonly workers: (() => Promise<readonly WorkerRecord[]>) | undefined;
}

const FIX =
  'x jobs list --json — every queue listed with no worker needs one: WORKER_QUEUES=<queue>,<queue> on another worker Deployment, or add it to this one';

/** Never rejects: a boot line is advice, and a failed read of it must not fail the boot. */
export async function reportUnservedQueues(input: UnservedQueuesInput): Promise<void> {
  const left = [...new Set(input.registered)].filter((q) => !input.served.includes(q)).sort();
  if (left.length === 0) return;
  // Unknowable here: said at info, because the split may well be served elsewhere.
  const unknown = (reason: string): void =>
    logger.info('jobs.worker.queue-unserved', {
      queues: left,
      served: input.served,
      checked: false,
      reason,
      fix: FIX,
    });
  if (input.workers === undefined) return unknown('this driver keeps no worker registry');
  let rows: readonly WorkerRecord[];
  try {
    rows = await input.workers();
  } catch (error) {
    return unknown(renderThrowable(error));
  }
  // A draining worker is leaving: it claims nothing new, so it serves no queue.
  const covered = new Set(rows.filter((one) => one.draining !== true).flatMap((one) => one.queues));
  const queues = left.filter((queue) => !covered.has(queue));
  if (queues.length === 0) return;
  logger.warn('jobs.worker.queue-unserved', { queues, served: input.served, fix: FIX });
}
