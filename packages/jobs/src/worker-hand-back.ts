// Single responsibility: returning the rest of a claimed batch a round cannot start. Split from
// `worker.ts` at the file-size ceiling. A fleet-slot write that rejected mid-batch rethrew out of
// `claimRound` and stranded every job behind it in `running`, each with an attempt burned.

import { logger, renderThrowable } from '@ultimat3/core';
import type { ClaimedJob, JobDriver } from './driver';

/**
 * Each job returned exactly as a shed returns one — no attempt burned, no `lastError` — so
 * another worker takes it at once. Best-effort per job: the failure that got us here is usually
 * the database, one nack failing must not stop the rest being tried, and a job whose nack also
 * fails comes back when its visibility timeout lapses.
 */
export async function handBack(
  driver: JobDriver,
  jobs: readonly ClaimedJob[],
  options: { readonly delayMs: number; readonly workerId: string },
): Promise<void> {
  for (const claimed of jobs) {
    await driver
      .nack(claimed.id, { delayMs: options.delayMs, countsAsAttempt: false })
      .catch((error: unknown) => {
        logger.debug('jobs.worker.hand_back_failed', {
          workerId: options.workerId,
          jobId: claimed.id,
          error: renderThrowable(error),
        });
      });
  }
}
