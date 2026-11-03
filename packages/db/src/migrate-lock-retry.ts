// Single responsibility: send one unit of a migration again when `lock_timeout` fires. A deploy that
// dies because one reader held a table for 5 s is a wedged rollout for a thing that heals by itself.
// `migration-step.ts` picks the unit: a transactional step whole, since it rolled back whole, and a
// non-transactional step one statement at a time, since what already ran stays run.

import { isUltimateError, jitterStatedDelay, logger, type Random } from '@ultimat3/core';
import { DbError } from './errors';

/** Retries after the first attempt, so six tries: at 3 s each, near half a minute of patience. */
export const MIGRATION_LOCK_RETRIES = 5;

export interface LockRetryPolicy {
  readonly retries: number;
  readonly lockTimeoutMs: number;
  /** Seams; a test asserts the schedule rather than sleeping through it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly random?: Random | undefined;
}

/**
 * At least one `lockTimeoutMs` between attempts. While the ALTER queued, every query on that table
 * queued behind it, and going straight back in would stack the same queue on a table that has had
 * no time to serve it. Jitter upward only, so that floor is a floor.
 */
export async function withLockRetry(
  id: string,
  policy: LockRetryPolicy,
  attempt: () => Promise<void>,
): Promise<void> {
  const sleep = policy.sleep ?? Bun.sleep;
  const random = policy.random ?? Math.random;
  for (let done = 1; ; done += 1) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (!isUltimateError(error) || error.code !== 'X_DB_LOCK_TIMEOUT') throw error;
      const { cause, fix } = error;
      if (done > policy.retries) {
        throw new DbError({
          code: 'X_DB_LOCK_TIMEOUT',
          cause: `migration "${id}" gave up after ${done} attempts, ${policy.lockTimeoutMs} ms of lock wait each: ${cause}`,
          fix,
          meta: { id, attempts: done },
          sourceError: error,
        });
      }
      const waitMs = jitterStatedDelay(policy.lockTimeoutMs, policy.lockTimeoutMs, random);
      logger.warn('ultimate migrate lock wait timed out, trying again', {
        id,
        attempt: done,
        of: policy.retries + 1,
        waitMs,
        cause,
        fix,
      });
      await sleep(waitMs);
    }
  }
}
