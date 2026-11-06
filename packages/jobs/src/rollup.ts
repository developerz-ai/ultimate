// `rollup()` — a factory over `job()` that re-aggregates every bucket from the one holding
// `now - lookback` on, read from that bucket's first instant, and writes them into the app's own
// table with ONE `upsertAll` on `key`: idempotent, late rows land, a failed write leaves no half
// window. Dimensions and schedule are the app's (axiom 8).

import type { Ctx } from '@ultimat3/core';
import type { EntityCore, SeriesUnit, UpsertArgs } from '@ultimat3/entity';
import { bucketStart, SERIES_UNITS } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { isValidTimeZone } from '@ultimat3/time';
import { type DurationInput, finiteDurationMs, nowMs } from './clock';
import type { JobHandle } from './job';
import { job } from './job';
import { DEFAULT_RETRY, type RetryPolicy } from './retry';
import { RollupInvalidError } from './rollup-errors';
import type { JobTenant } from './tenant';

/** One run's payload: the tenant the window is read for, when the rollup is enqueued per org. */
export interface RollupInput {
  readonly orgId?: string | undefined;
}

/** The bucket every row of `into` stands for: a series unit, in a named IANA zone. */
export interface RollupBucket {
  readonly unit: SeriesUnit;
  readonly timeZone: string;
}

/** What the run writes through: the app's table handle, `db.<into>`. */
export interface RollupTarget<Into, W> {
  upsertAll(rows: readonly W[], args: UpsertArgs<Into>): Promise<readonly unknown[]>;
}

export interface RollupDefinition<S, Into, W> {
  /** REQUIRED: the queue row and `x jobs show` carry it, as a backfill's does. */
  readonly name: string;
  /** The entity the buckets land in — the app's own table. Its unique index over `key` is checked here. */
  readonly into: EntityCore<Into>;
  /** `() => db.<into>`: a thunk, so the module that declares the job never opens the database. */
  readonly table: () => RollupTarget<Into, W>;
  /** The properties that name one bucket: `['orgId', 'postId', 'day']`. A unique index covers them. */
  readonly key: readonly (keyof Into & string)[];
  /**
   * REQUIRED: how late a row may arrive and still count. Every run recomputes the buckets from
   * the one holding `now - lookback` on; a row older than that when it lands is in no run.
   */
  readonly lookback: DurationInput;
  /**
   * REQUIRED: the unit and zone of one bucket — the same the `source` series buckets by. The run
   * opens its window at the first instant of the bucket holding `now - lookback`, so the first
   * bucket it upserts whole is read whole.
   */
  readonly bucket: RollupBucket;
  /**
   * The window, read from `since` — a bucket's first instant — and bucketed by `bucket`:
   * `db.likes.andWhere('createdAt', 'gte', since).series({ on: 'createdAt', ...bucket, value })`.
   */
  source(args: {
    readonly ctx: Ctx;
    readonly since: Date;
    readonly bucket: RollupBucket;
    readonly input: RollupInput;
  }): Promise<readonly S[]>;
  /** One item of `source` → one row of `into`, its `key` filled. */
  map(item: S, args: { readonly input: RollupInput }): W;
  /** REQUIRED, as on every job: `(input) => input.orgId ?? …`, or `'none'` for one spanning orgs. */
  readonly tenant: JobTenant<RollupInput>;
  readonly queue?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: DurationInput;
}

/** What one run reports: the window it recomputed and the rows it wrote. */
export interface RollupReport {
  readonly since: string;
  readonly rows: number;
}

/** The unique constraints of `into`, as sets of PHYSICAL column names: key, indexes, invariants. */
const uniqueSets = <Into>(into: EntityCore<Into>): readonly (readonly string[])[] => {
  const described = into.$describe();
  const physical = new Map(described.columns.map((column) => [column.property, column.column]));
  return [
    into.$primaryKey.map((property) => physical.get(property) ?? property),
    ...described.indexes
      .filter((index) => index.unique && index.where === null)
      .map((i) => i.columns),
    ...described.invariants
      .filter((rule) => rule.kind === 'unique' && rule.where === null)
      .map((rule) => rule.columns ?? []),
  ].map((columns) => [...columns].sort());
};

const UNITS: ReadonlySet<string> = new Set(SERIES_UNITS);

/** The bucket, judged as `series()` judges its own: a closed unit, an IANA zone. */
const assertBucket = (name: string, bucket: RollupBucket | undefined, example: string): void => {
  if (bucket === undefined || !UNITS.has(bucket.unit)) {
    throw new RollupInvalidError({
      rollup: name,
      problem:
        bucket === undefined
          ? 'declares no bucket — the window must open where its first bucket does'
          : `declares bucket unit ${JSON.stringify(String(bucket.unit))}, which is not one of ${SERIES_UNITS.join(', ')}`,
      fix: `${example}   # bucket.unit is one of: ${SERIES_UNITS.join(', ')}`,
    });
  }
  if (typeof bucket.timeZone !== 'string' || !isValidTimeZone(bucket.timeZone)) {
    throw new RollupInvalidError({
      rollup: name,
      problem: `declares bucket timeZone ${JSON.stringify(String(bucket.timeZone))}, which is not an IANA zone`,
      fix: `${example}   # an IANA zone such as UTC or Europe/Berlin, never an abbreviation or an offset`,
    });
  }
};

/** Refused where it was written: a rollup that cannot write is a dead letter at its first run. */
const assertRollup = <S, Into, W>(definition: RollupDefinition<S, Into, W>): number => {
  const name = definition.name;
  const example = `rollup({ name: '${name}', into, table, key: ['orgId', 'day'], lookback: '2d', bucket: { unit: 'day', timeZone: 'UTC' }, source, map, tenant })`;
  if (definition.lookback === undefined) {
    throw new RollupInvalidError({
      rollup: name,
      problem:
        'declares no lookback — how late a row may arrive and still count is the app’s to say',
      fix: `${example}   # lookback is required`,
    });
  }
  const lookbackMs = finiteDurationMs(definition.lookback, `rollup "${name}"`, 'lookback');
  if (!(lookbackMs > 0)) {
    throw new RollupInvalidError({
      rollup: name,
      problem: `declares lookback ${JSON.stringify(definition.lookback)}, which is no window`,
      fix: `${example}   # a positive duration`,
    });
  }
  assertBucket(name, definition.bucket, example);
  const described = definition.into.$describe();
  const physical = new Map(described.columns.map((column) => [column.property, column.column]));
  const key = definition.key.map((property) => physical.get(property));
  const wanted = key.filter((column): column is string => column !== undefined).sort();
  const covered = uniqueSets(definition.into).some(
    (columns) => columns.length === wanted.length && columns.every((c, at) => c === wanted[at]),
  );
  if (key.length === 0 || wanted.length !== key.length || !covered) {
    throw new RollupInvalidError({
      rollup: name,
      problem: `keys its buckets by (${definition.key.join(', ')}), which no unique constraint on ${definition.into.$name} covers — the upsert would have no row to land on`,
      fix: `entity('${definition.into.$name}', { indexes: [{ on: [${definition.key.map((k) => `'${k}'`).join(', ')}], unique: true }] })   # then x db gen`,
    });
  }
  return lookbackMs;
};

export function rollup<S, Into, W>(
  definition: RollupDefinition<S, Into, W>,
): JobHandle<RollupInput> {
  const lookbackMs = assertRollup(definition);
  const bucket: RollupBucket = {
    unit: definition.bucket.unit,
    timeZone: definition.bucket.timeZone,
  };
  return job<RollupInput, RollupReport>({
    name: definition.name,
    input: t.object({ orgId: t.string.optional() }),
    // One live run per window: a second enqueue while one is running is the same recomputation.
    idempotencyKey: (input) => `rollup:${definition.name}:${input.orgId ?? '*'}`,
    tenant: definition.tenant,
    retry: definition.retry ?? DEFAULT_RETRY,
    ...(definition.queue === undefined ? {} : { queue: definition.queue }),
    ...(definition.timeout === undefined ? {} : { timeout: definition.timeout }),
    run: ({ ctx, input, step }) =>
      // One step: the read and the write are one decision, and a replay recomputes both.
      step.run('rollup', async () => {
        // The bucket holding `now - lookback` is upserted whole, so it is read whole: from its
        // first instant in its zone, by the rule `series()` buckets with — DST included.
        const since = bucketStart(
          new Date(nowMs(ctx.clock) - lookbackMs),
          bucket.unit,
          bucket.timeZone,
        );
        const items = await definition.source({ ctx, since, bucket, input });
        const rows = items.map((item) => definition.map(item, { input }));
        // ONE call: a single statement, or several in one transaction past the bind limit — so
        // a run cut short writes every bucket or none of them, never half a window.
        await definition.table().upsertAll(rows, { onConflict: definition.key });
        return { since: since.toISOString(), rows: rows.length };
      }),
  });
}
