// `purge()` — the framework's retention sweep, declared as a `job` and NOT as a ninth primitive.
// Deleting expired rows on a schedule is durable background work with an input schema, a retry
// policy, an idempotency key and a queue, which is the definition of a `job` — so this file is a
// FACTORY over `job()`, exactly as `backfill()` is one and `llm()` is one over `action()`. That is
// what gives a retention sweep `.enqueue()`, the worker's cancellation, the dead-letter path,
// `x jobs show` and a manifest row without a line here.
//
// WHY it exists: `postgresIdempotencyStore`, `postgresRateLimitStore` and `postgresAuthLimiter`
// each shipped a `purgeExpired()` and NOTHING called any of them, so every row those three tables
// ever took was a row kept. `x_rate_limit` takes one upsert per HTTP request a web role serves,
// assets included, so its growth is proportional to total traffic rather than to traffic that hit
// a limit. A `task` could not fix it: a task only ENQUEUES, which is this package's design.

import type { Clock } from '@ultimat3/core';
import { assert, logger } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';

/**
 * One table's worth of expired rows, behind the narrowest possible seam.
 *
 * Structural, exactly like `JobActor` and `PgExecutor`: the three stores this was written for live
 * in `@ultimat3/action` (this tier), `@ultimat3/http` and `@ultimat3/auth` — none of them
 * importable here — and a sweep that needed their types would put the whole HTTP pipeline on this
 * package's import graph. A store satisfies this by having the method it already has.
 */
export interface PurgeTarget {
  /**
   * What this sweep is called in its durable step, its log line and its report. A table name is
   * the natural spelling (`x_rate_limit`); a target that clears a SET of tables names their common
   * prefix (`x_auth`, for `x_auth_failures` and `x_auth_lockouts`). Unique within one definition —
   * the name is the step key, and two steps under one name is `X_STEP_DUPLICATE` mid-run.
   */
  readonly name: string;
  /**
   * Delete every expired row and answer how many went.
   *
   * `nowMs` is the JOB's clock, and a store that writes its instants from the caller MUST measure
   * against it rather than against `now()` on the server. That mismatch is not theoretical: the
   * http store's purge read `extract(epoch from now())` against a `last_ms` written by the caller
   * and, on a frozen test clock, computed a 20,000,000-second refill and deleted a bucket holding
   * 0 of 4 tokens — a free limit reset, handed out by the cleanup. A store that holds its own
   * clock (because its host handed it one) may ignore this argument; a store that holds none
   * may not.
   */
  purgeExpired(nowMs: number): Promise<number>;
}

/** What one target's sweep removed. Bounded and JSON-safe, so it survives as a step's output. */
export interface PurgeSweep {
  readonly name: string;
  readonly removed: number;
}

/** What one pass reports — bounded, so `x jobs show` can print it. */
export interface PurgeReport {
  readonly swept: readonly PurgeSweep[];
  readonly removed: number;
}

/**
 * A purge decides nothing, so its payload carries nothing. Deliberately not a `force` flag like
 * `BackfillInput`'s: a backfill is a ONE-PASS sweep whose ledger says it already ran, and this is
 * a recurring one with no ledger and nothing to override.
 */
export type PurgeInput = Readonly<Record<string, never>>;

export interface PurgeDefinition {
  /**
   * Omit it and `defineApi({ jobs })` assigns the export name. A framework-owned sweep pins one,
   * the way `mail.send` does, because the queue key is what rows already carry.
   */
  readonly name?: string;
  /**
   * The tables to sweep, read ONCE PER ATTEMPT rather than captured at declaration. Lazy because
   * a host declares the sweep at boot and the stores behind it are not all resolved yet — an
   * app's `defineAuth` runs after the boot that installed the limiter factory, so the auth target
   * does not exist until later. An empty list is a pass that removes nothing, which is the honest
   * answer for a process whose boot has already stopped.
   */
  targets(): readonly PurgeTarget[];
  /**
   * The clock every target is measured against. Defaults to the system clock, and it must be the
   * SAME clock the stores write their instants from — see `PurgeTarget.purgeExpired`.
   */
  readonly clock?: Clock;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  /** Per attempt. A killed attempt resumes at the first table it had not yet checkpointed. */
  readonly timeout?: DurationInput;
}

/** The cron a framework-shipped sweep runs on when its host has no opinion. */
export const DEFAULT_PURGE_CRON = '23 * * * *';

export function purge(definition: PurgeDefinition): JobHandle<PurgeInput> {
  const clock = definition.clock;

  return job<PurgeInput>({
    ...(definition.name === undefined ? {} : { name: definition.name }),
    input: t.object({}),
    // One live sweep, forever: a second enqueue while a pass is still running is the same pass,
    // and two deletes racing over one table buy nothing but lock contention. The scheduler's own
    // key is occurrence-scoped on top of this, so the hourly runs are still distinct.
    idempotencyKey: () => 'purge',
    // Framework tables, not an org's rows. Every statement behind a target is raw SQL over the
    // whole table, so there is no tenant-scoped read here to fail closed.
    tenant: 'none',
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    async run({ step }): Promise<PurgeReport> {
      // ONE reading for every target in the pass. Two readings would let two tables be measured
      // against instants a round trip apart, which is the same class of mismatch as reading the
      // server's clock — smaller, and just as unnecessary.
      const at = nowMs(clock);
      const targets = definition.targets();
      const names = new Set(targets.map((target) => target.name));
      // Refused before the first delete, not discovered at the second step: `step.run` raises
      // `X_STEP_DUPLICATE` on the repeat, which dead-letters a sweep AFTER it has already emptied
      // one table. The list is lazy, so this cannot be checked at declaration.
      assert(
        names.size === targets.length,
        `purge targets repeat a name: ${[...names].sort().join(', ')} across ${targets.length} targets`,
        'give every PurgeTarget its own name — the name is the durable step key, and two steps under one name is X_STEP_DUPLICATE',
      );

      const swept: PurgeSweep[] = [];
      for (const target of targets) {
        // One durable step per table, so a killed attempt resumes at the table it stopped on
        // rather than sweeping the ones already done a second time. At least once either way, and
        // a purge is idempotent by nature: a replayed delete removes the rows that are already
        // gone, which is none, and a row this deletes answers exactly as a row that was never
        // there — no decision anywhere changes.
        const removed = await step.run(target.name, () => target.purgeExpired(at));
        swept.push({ name: target.name, removed });
      }
      const removed = swept.reduce((total, sweep) => total + sweep.removed, 0);
      // Ops reads this to size the cadence: a sweep that removes hundreds of thousands every hour
      // is a table that wants a shorter window, not a longer cron.
      if (removed > 0) logger.info('jobs.purge.swept', { removed, tables: swept.length });
      return { swept, removed };
    },
  });
}
