// What the scheduler LEADER does besides dispatching, on its own cadence: fold old counter buckets
// (`COUNTER_TIERS`) and re-drive the `onSettled` debts dead workers left (J11). Split off
// `scheduler.ts` at its size ceiling. The re-drive runs beside the round, never inside it: 50
// hooks of up to `onSettledTimeout` each must not hold every task's dispatch behind them.

import type { Ctx } from '@ultimat3/core';
import { isUltimateError, logger, renderThrowable } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { redriveLostSettles } from './settle-redrive';

/** How often the leader folds old counter buckets. Only buckets a day old ever move. */
export const COUNTER_ROLLUP_INTERVAL_MS = 600_000;
/** After a fold that moved nothing. Late costs extra rows, never a wrong count: reads span tiers. */
export const COUNTER_ROLLUP_IDLE_INTERVAL_MS = 3_600_000;

/** How often the leader asks for lost `onSettled` debts after a pass that found some. */
export const SETTLE_REDRIVE_INTERVAL_MS = 60_000;
/**
 * After a pass that found none — the common case, a crash being rare. A lost debt then waits at
 * most its grace plus this, and an idle queue pays 12 statements an hour for the guarantee.
 */
export const SETTLE_REDRIVE_IDLE_INTERVAL_MS = 300_000;

/**
 * A round that failed, as log fields. `message` alone throws away the half of an `UltimateError`
 * that makes it actionable — the operator reading `jobs.scheduler.tick-failed` at 3am needs the
 * stable code to search on and the `fix:` to run, not a sentence.
 */
export function failureFields(error: unknown): Record<string, unknown> {
  const message = renderThrowable(error);
  return isUltimateError(error)
    ? { error: message, code: error.code, cause: error.cause, fix: error.fix }
    : { error: message };
}

export interface LeaderUpkeep {
  /** The leader's turn at `at`: whatever is due runs; the re-drive is started, not awaited. */
  run(at: number): Promise<void>;
  /** The re-drive pass in flight, for a drain to wait out. */
  inFlight(): readonly Promise<unknown>[];
}

export interface LeaderUpkeepOptions {
  readonly driver: JobDriver;
  readonly context: () => Ctx;
}

export function leaderUpkeep(options: LeaderUpkeepOptions): LeaderUpkeep {
  let nextRollupAt = Number.NEGATIVE_INFINITY;
  let nextRedriveAt = Number.NEGATIVE_INFINITY;
  let redrive: Promise<unknown> | undefined;
  return {
    async run(at) {
      const operator = options.driver.introspect;
      if (operator !== undefined && at >= nextRollupAt) {
        nextRollupAt = at + COUNTER_ROLLUP_INTERVAL_MS;
        const moved = await operator.rollupCounters().catch((error: unknown) => {
          logger.warn('jobs.scheduler.rollup-failed', failureFields(error));
          return undefined;
        });
        if (moved === 0) nextRollupAt = at + COUNTER_ROLLUP_IDLE_INTERVAL_MS;
      }
      if (redrive !== undefined || at < nextRedriveAt) return;
      nextRedriveAt = at + SETTLE_REDRIVE_INTERVAL_MS;
      redrive = redriveLostSettles({ driver: options.driver, context: options.context })
        .then((taken) => {
          if (taken === 0) nextRedriveAt = at + SETTLE_REDRIVE_IDLE_INTERVAL_MS;
          else logger.info('jobs.scheduler.settles-redriven', { taken });
        })
        .catch((error: unknown) =>
          logger.warn('jobs.scheduler.redrive-failed', failureFields(error)),
        )
        .finally(() => {
          redrive = undefined;
        });
    },
    inFlight: () => (redrive === undefined ? [] : [redrive]),
  };
}
