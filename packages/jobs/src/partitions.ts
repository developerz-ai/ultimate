// `partitions()`: the maintenance every `entity({ partitionBy })` needs — partitions created ahead,
// expired ones dropped — as a FACTORY over `job()` plus a `.schedule` `task()` (default daily), the
// shape `consumer()`'s `.supervisor` has. Never a ninth primitive. The work is `@ultimat3/db`'s
// `maintainPartitions` (bounded lock waits, `detach … concurrently`), judged at THIS job's clock.

import type { Clock } from '@ultimat3/core';
import { assert, liveClock } from '@ultimat3/core';
import { db, maintainPartitions } from '@ultimat3/db';
import type { EntityDescription } from '@ultimat3/entity';
import { registeredEntities } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { nowMs } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { TaskHandle } from './task';
import { task } from './task';

/** 03:17 UTC daily: off the hour every other cron in a fleet picks, and well before month-end. */
export const DEFAULT_PARTITIONS_CRON = '17 3 * * *';

export const DEFAULT_PARTITIONS_NAME = 'partitions';

export interface PartitionsDefinition {
  /** The job's durable name; the task is `<name>.schedule`. Default `DEFAULT_PARTITIONS_NAME`. */
  readonly name?: string;
  /** Default `DEFAULT_PARTITIONS_CRON`. Daily is enough for any interval but `day` with `ahead: 0`. */
  readonly cron?: string;
  /** Default `'UTC'`: partition bounds are UTC, so the schedule is too. */
  readonly tz?: string;
  /** The instant partitions are judged at — the framework clock, so a test can move it. */
  readonly clock?: Clock;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
}

/** One partitioned table's maintenance: the partitions this run created and dropped. */
export interface PartitionsTableReport {
  readonly table: string;
  readonly created: readonly string[];
  readonly dropped: readonly string[];
}

export interface PartitionsReport {
  readonly tables: readonly PartitionsTableReport[];
}

/**
 * The job's input. The schedule enqueues `{}`. Before a `backfill()` copies rows older than the
 * table's first partition, enqueue it once with `from`: the oldest row's instant (ISO). That run
 * creates every partition back to it and sweeps nothing, so the copy routes instead of `23514`.
 */
export interface PartitionsInput {
  readonly from?: string | undefined;
}

/** The maintenance job, with the `task()` that enqueues it — as `consumer()` carries `.supervisor`. */
export interface PartitionsJob extends JobHandle<PartitionsInput> {
  readonly schedule: TaskHandle;
}

/** Every registered entity declaring `partitionBy`, described, in registry name order. */
export const partitionedEntities = (): readonly EntityDescription[] =>
  registeredEntities()
    .map((entry) => entry.describe())
    .filter((described) => described.partition != null);

/** `from` as an instant, or refused where it was enqueued: a bad bound would create nothing. */
function fromOf(name: string, from: string | undefined): Date | undefined {
  if (from === undefined) return undefined;
  const at = new Date(from);
  assert(
    !Number.isNaN(at.getTime()),
    `${name}: from "${from}" is no ISO instant`,
    `enqueue ${name} with { from: '2025-01-01T00:00:00.000Z' } — the oldest row's instant`,
  );
  return at;
}

export function partitions(definition: PartitionsDefinition = {}): PartitionsJob {
  const name = definition.name ?? DEFAULT_PARTITIONS_NAME;
  const clock = definition.clock ?? liveClock;
  const handle = job<PartitionsInput>({
    name,
    input: t.object({ from: t.string.optional() }),
    // Partitions are tables, not any tenant's rows.
    tenant: 'none',
    // One live pass: a second tick while one runs is the same pass, and the SQL is idempotent anyway.
    // A `from` run is a different pass: it must not fold into the schedule's.
    idempotencyKey: (input) => (input.from === undefined ? name : `${name}:from:${input.from}`),
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    async run({ input, step }): Promise<PartitionsReport> {
      const from = fromOf(name, input.from);
      const tables: PartitionsTableReport[] = [];
      // Read per run, never at declaration: an entity module may load after this one.
      for (const described of partitionedEntities()) {
        // One step per table: a retry resumes at the table that failed, never re-dropping.
        const report = await step.run(`partitions:${described.table}`, async () => {
          const run = await maintainPartitions(db(), described, new Date(nowMs(clock)), { from });
          return { table: described.table, created: run.created, dropped: run.dropped };
        });
        tables.push(report);
      }
      return { tables };
    },
  });
  const schedule = task({
    name: `${name}.schedule`,
    cron: definition.cron ?? DEFAULT_PARTITIONS_CRON,
    tz: definition.tz ?? 'UTC',
    enqueue: () => [[handle, {}]],
  });
  return Object.assign(handle, { schedule });
}
