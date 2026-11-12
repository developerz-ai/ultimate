// The re-drive half of `onSettled`'s at-least-once (J11): the scheduler leader takes the debts a
// dead worker left — settled rows whose hook never returned — and runs each hook again, told
// `redriven: true, reason: 'lost'`, then pays the debt. One pass, at most `SETTLE_REDRIVE_LIMIT`,
// none started past the grace its take bought, and none once its leader has stopped.

import type { Clock, Ctx } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobDriver, JobRecord } from './driver';
import type { AnyJobHandle } from './job';
import { registeredJobs } from './job';
import { announceSettled } from './settled';
import type { Settlement } from './settled-types';

/** Rows one pass takes at most: the rest wait for the next, oldest first. */
export const SETTLE_REDRIVE_LIMIT = 50;

/**
 * A debt counts as LOST once it is this many hook ceilings (`onSettledTimeout`) old: the worker
 * that settled the row would have finished every try, or been stopped, well inside it.
 */
export const SETTLE_GRACE_FACTOR = 3;

export interface RedriveOptions {
  readonly driver: JobDriver;
  /** The context each hook is scoped from, as a worker's `context()` is. */
  readonly context: () => Ctx;
  /** Defaults to every registered job. */
  readonly jobs?: readonly AnyJobHandle[];
  /** What the pass measures its own time on — the scheduler's clock. */
  readonly clock?: Clock;
  /** Asked before each row: `true` — leadership lost, the scheduler stopping — ends the pass. */
  readonly stopped?: () => boolean;
}

/** The leading `X_*` code of a recorded failure — read from the row, never invented. */
const codeOf = (error: string): string | undefined => /\b(X_[A-Z0-9_]+):/.exec(error)?.[1];

/**
 * How the row ended, as its own state and failure say. A `done` row owes a hook only when its body
 * returned `undefined` (`executeJob`'s ack), so `undefined` IS the result, not a stand-in for one.
 */
function settlementOf(row: JobRecord): Settlement {
  if (row.state === 'done') return { outcome: 'completed', result: undefined, redriven: true };
  const error = row.lastError ?? '';
  const code = codeOf(error);
  // `failed` is a `whenBusy: 'fail'` refusal or a `retry.deadLetter: false` drop: the code tells.
  const outcome =
    row.state === 'dead' ? 'dead-lettered' : code === 'X_JOB_KEY_BUSY' ? 'refused' : 'dropped';
  return { outcome, error, code, redriven: true };
}

/**
 * Re-drive every lost debt one pass can take, and answer how many rows it took. A driver with no
 * `settleDebt`, or a deploy where no job declares `onSettled`, costs no statement at all.
 */
export async function redriveLostSettles(options: RedriveOptions): Promise<number> {
  const debt = options.driver.settleDebt;
  if (debt === undefined) return 0;
  const hooked = (options.jobs ?? registeredJobs()).filter((handle) => handle.declaresOnSettled);
  if (hooked.length === 0) return 0;
  const byName = new Map(hooked.map((handle) => [handle.name, handle]));
  const lost = await debt.takeLost(
    hooked.map((handle) => ({
      name: handle.name,
      graceMs: handle.onSettledTimeoutMs * SETTLE_GRACE_FACTOR,
    })),
    SETTLE_REDRIVE_LIMIT,
  );
  // The take reset every debt's clock to now: each is held for ONE grace from here, and another
  // leader may take it again after that. A pass drives serially, so a row is started only while
  // its hook — bounded by `onSettledTimeout`, every try included — still ends inside that grace.
  // The rest stay owed for the next pass; none is ever told twice at once.
  const takenAt = nowMs(options.clock);
  for (const row of lost) {
    if (options.stopped?.() === true) break;
    const handle = byName.get(row.name);
    if (handle === undefined) continue;
    const ceiling = handle.onSettledTimeoutMs;
    if (nowMs(options.clock) - takenAt + ceiling > ceiling * SETTLE_GRACE_FACTOR) continue;
    let ctx: Ctx;
    try {
      ctx = options.context();
    } catch (raised) {
      // Left owed: the next pass after the grace tries again.
      logger.error('jobs.on-settled.redrive-unscoped', {
        job: row.name,
        jobId: row.id,
        error: renderThrowable(raised),
      });
      continue;
    }
    logger.warn('jobs.on-settled.redriven', { job: row.name, jobId: row.id, state: row.state });
    await announceSettled({
      handle,
      claimed: row,
      ctx,
      settlement: settlementOf(row),
      owed: { debt, claim: row.claim ?? 0 },
    });
  }
  return lost.length;
}
