// Single responsibility: the `queue_demand` gauge one worker process publishes. Split from
// `worker-queue-depth.ts` because this gauge alone asks the driver a second question, and alone must
// go quiet when the worker drains.

import type { JobDriver, QueueDemand, QueueStats } from './driver';
import { recordQueueDemand } from './metrics';

export interface DemandGauge {
  /** Taken BEFORE the round's `stats()`: a drain landing during that read moves it too. */
  fence(): number;
  /** One round, off the `stats()` it read under `fence`. A failed read rejects, zeroing nothing. */
  publish(stats: readonly QueueStats[], fence: number): Promise<void>;
  retract(): void;
}

/**
 * `stats()` bounds the answer, so an idle fleet is not asked: a queue with nothing ready, running or
 * suspended has no demand, and `idle-cost.test.ts` holds what an idle worker may cost.
 */
function readDemand(
  driver: JobDriver,
  stats: readonly QueueStats[],
): Promise<readonly QueueDemand[]> {
  const live = stats.some((stat) => stat.ready + stat.running + stat.suspended > 0);
  return live ? driver.demand() : Promise.resolve([]);
}

/**
 * Every worker publishes the same fleet-wide number, so a reader takes `max by (queue)`. That is why
 * `retract` exists: the claim loop is what publishes, and it stops at the drain, so a retiring pod's
 * last value would otherwise stand for as long as its job runs, up to the retire, and `max` would
 * read it over every live worker's. Zero is honest: the pods still serving carry the true number.
 */
export function createDemandGauge(driver: JobDriver): DemandGauge {
  // The queues the last round listed: a gauge keeps its last value, so one that drops out is zeroed.
  let published: ReadonlySet<string> = new Set();
  // Moved by `retract`, so a round whose read was in flight at the drain records nothing.
  let generation = 0;

  return {
    fence: () => generation,
    async publish(stats, fence) {
      if (fence !== generation) return;
      const rows = await readDemand(driver, stats);
      if (fence !== generation) return;
      const listed = new Set(rows.map((row) => row.queue));
      for (const queue of published) if (!listed.has(queue)) recordQueueDemand(queue, 0);
      published = listed;
      for (const row of rows) recordQueueDemand(row.queue, row.demand);
    },
    retract() {
      generation += 1;
      for (const queue of published) recordQueueDemand(queue, 0);
      published = new Set();
    },
  };
}
