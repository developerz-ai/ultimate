// What one worker has settled, by outcome — the counters `stats()` reports. Split from `worker.ts`
// at the file-size ceiling; the claim loop counts, this file says what each count means.

import type { JobExecution } from './execute';
import type { WorkerStats } from './worker-types';

export type WorkerTallies = Pick<
  WorkerStats,
  'processed' | 'failed' | 'suspended' | 'deadLettered' | 'interrupted' | 'refused' | 'dropped'
>;

export interface WorkerTally {
  /** One run's execution, counted under its outcome. */
  count(execution: JobExecution): void;
  /** Rows the claim itself buried (`claim-exhausted.ts`), never handed out as work. */
  buried(ended: { readonly deadLettered: number; readonly dropped: number }): void;
  /** A run refused by its concurrency key, body never started (`worker-key-busy.ts`). */
  refused(): void;
  snapshot(): WorkerTallies;
}

export function createWorkerTally(): WorkerTally {
  const tallies = {
    processed: 0,
    failed: 0,
    suspended: 0,
    deadLettered: 0,
    interrupted: 0,
    refused: 0,
    dropped: 0,
  };
  return {
    count(execution) {
      // `retried` is counted as `failed`: the attempt failed, the job did not.
      if (execution.outcome === 'completed') tallies.processed += 1;
      else if (execution.outcome === 'suspended') tallies.suspended += 1;
      else if (execution.outcome === 'retried') tallies.failed += 1;
      else if (execution.outcome === 'interrupted') tallies.interrupted += 1;
      else if (execution.outcome === 'dead-lettered') tallies.deadLettered += 1;
      else if (execution.outcome === 'dropped') tallies.dropped += 1;
    },
    buried(ended) {
      tallies.deadLettered += ended.deadLettered;
      tallies.dropped += ended.dropped;
    },
    refused() {
      tallies.refused += 1;
    },
    snapshot() {
      return { ...tallies };
    },
  };
}
