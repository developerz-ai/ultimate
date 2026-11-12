// One relay pass's publish: a claimed batch turned into queued jobs, in staged order, stopping at
// the first row that fails. Split from `outbox-relay.ts`, which owns the loop, its timer and its
// drain. Runs of plain rows go out as one `enqueueMany`; a debounced or expiring row goes alone.

import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import { publishRequest } from './enqueue-record';
import type { OutboxDeps, OutboxRecord } from './outbox';

/**
 * A row `enqueueMany` would refuse (`assertEnqueueMany`): `'replace'` cannot update one row twice
 * in one statement, and an expiry is a single enqueue's. It is published alone, in its place.
 */
const alone = (record: OutboxRecord): boolean =>
  record.onConflict === 'replace' || record.expiresAt !== undefined;

/**
 * A run of rows in TWO statements — `driver.enqueueMany`, then `store.markPublishedMany` — where the
 * row loop spends two per row; `RELAY_BATCH_SIZE` holds the measured figures. Publish, then mark,
 * the row loop's order and for its reason.
 *
 * `false` hands the run to the row loop: a store without `markPublishedMany`, or a run that failed
 * anywhere. The loop then publishes in order up to the row that fails and releases the rest, so the
 * order guarantee and the poison row named in `jobs.outbox.publish-failed` are the loop's,
 * unchanged. A run that published before its mark failed is published again by the loop, by the
 * same ids, which `SQL_ENQUEUE` answers `deduped` without a second row.
 */
async function publishRun(deps: OutboxDeps, run: readonly OutboxRecord[]): Promise<boolean> {
  const { driver, store } = deps;
  if (store.markPublishedMany === undefined) return false;
  try {
    await driver.enqueueMany(run.map(publishRequest));
    // One claim stamped every row of the batch, so the first row's token is the run's.
    await store.markPublishedMany(
      run.map((record) => record.id),
      nowMs(deps.clock),
      run[0]?.claimedBy,
    );
    return true;
  } catch (error) {
    logger.warn('jobs.outbox.batch-fallback', {
      rows: run.length,
      error: renderThrowable(error),
    });
    return false;
  }
}

/** The rows from `from` on that may share one `enqueueMany`: up to the next row that goes alone. */
function plainRun(batch: readonly OutboxRecord[], from: number): readonly OutboxRecord[] {
  let end = from;
  for (let row = batch[end]; row !== undefined && !alone(row); row = batch[end]) end += 1;
  return batch.slice(from, end);
}

/**
 * Publish `batch` in order and answer how many rows were published. At-least-once by construction:
 * publish, THEN mark. On the first row that fails the pass STOPS — publishing later rows past it
 * would let an app's `chargeCard` run before the `createInvoice` it staged first — and hands the
 * rest of the claim back rather than sit on a lease nobody is publishing.
 */
export async function publishClaimed(
  deps: OutboxDeps,
  batch: readonly OutboxRecord[],
): Promise<number> {
  let published = 0;
  while (published < batch.length) {
    const run = plainRun(batch, published);
    if (run.length > 0 && (await publishRun(deps, run))) {
      published += run.length;
      continue;
    }
    // The row loop: a run whose batch publish could not be used, or the one row that goes alone.
    for (const record of run.length > 0 ? run : batch.slice(published, published + 1)) {
      try {
        // The ids the staging enqueue ANSWERED. Published under them, a repeat of this publish
        // — a crash before the mark below — meets the job this one made rather than adding one.
        await deps.driver.enqueue(publishRequest(record));
        // The claim's own token goes back with the mark. Without it a relay whose lease lapsed
        // mid-stall retires a row the relay that reclaimed it has not published yet.
        await deps.store.markPublished(record.id, nowMs(deps.clock), record.claimedBy);
        published += 1;
      } catch (error) {
        // The row stays unpublished and the next pass starts again from it; a permanently
        // poisoned row wedges its queue, visible in `pending()` — the correct trade against
        // silently reordering committed work.
        logger.warn('jobs.outbox.publish-failed', {
          job: record.job,
          id: record.id,
          published,
          remaining: batch.length - published,
          error: renderThrowable(error),
        });
        // Without this a single pool timeout parks every committed row behind it for the whole
        // lease window instead of for one poll interval.
        await deps.store.release?.(
          batch.slice(published).map((row) => row.id),
          record.claimedBy,
        );
        return published;
      }
    }
  }
  return published;
}
