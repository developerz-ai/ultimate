// Single responsibility: the chain's aggregate terminals — `countBy`, the four SQL aggregates,
// `approximateCount` and `series` — typed by the row and forwarded to the row-agnostic repository.
// Split from `query.ts` at its line ceiling; the chain's arguments arrive as `args()`, so every
// terminal here counts exactly the rows `count()` counts.

import type { Repo } from './repo';
import { seriesUnsupported } from './series-unsupported';
import type { SeriesPoint, SeriesUnit, SeriesValue } from './time-bucket';
import type { MoneyValue, NoSealedKeys, SealedKeySet } from './types';

/** The properties a series may bucket by: a `timestamp()` column, nullable or not, never sealed. */
export type TimestampKeys<Row, S extends SealedKeySet = NoSealedKeys> = {
  [K in keyof Row & string]: K extends S['sealed']
    ? never
    : [NonNullable<Row[K]>] extends [Date]
      ? K
      : never;
}[keyof Row & string];

/** What one bucket's `value` is: a count, or the sum `sum()` would answer over that bucket. */
export type SeriesValueOf<Row, V> = V extends 'count'
  ? number
  : V extends { readonly sum: infer K extends keyof Row }
    ? (Row[K] extends MoneyValue | null ? MoneyValue : string) | null
    : never;

/** `ReadBuilder.series`'s argument. `timeZone` is required: there is no ambient zone. */
export interface SeriesOptions<On, V> {
  readonly on: On;
  readonly unit: SeriesUnit;
  readonly timeZone: string;
  readonly value: V;
}

export interface ReadAggregates<Row, S extends SealedKeySet = NoSealedKeys> {
  /**
   * The grouped count: one statement, one entry per distinct value of `column`, keyed by that
   * value — the aggregate a `count()` per row is the N+1 of. `recount every post's likes` is one
   * `likes.andWhere('postId', 'in', ids).countBy('postId')`, not one statement per post.
   *
   * Counts the whole predicate, exactly as `count()` does: the chain's filters, its tenancy and
   * its soft-delete visibility, never its page. A value nothing matched is absent rather than `0`,
   * which is what `group by` returns and what lets a caller tell "none" from "never asked".
   * Entries come back biggest group first, ties by the value, `null` — the group every row without
   * one shares — last.
   *
   * Refused rather than answered: a column whose values a map cannot be keyed by (a timestamp, a
   * jsonb, money), and a chain matching more distinct values than one statement should answer with.
   */
  countBy<K extends Exclude<keyof Row & string, S['sealed']>>(
    column: K,
  ): Promise<ReadonlyMap<Row[K], number>>;
  /**
   * The four SQL aggregates, over exactly the rows `count()` counts — the chain's filters, its
   * tenancy and its soft-delete visibility, never its page. "Total spend this month" is
   * `payments.where({ orgId }).andWhere('paidAt', 'gte', from).sum('amount')`, one statement,
   * rather than a page loop or a hand-written query outside every guard this layer applies.
   *
   * **Never a float.** `sum` and `avg` answer decimal TEXT whatever the column was — the sum of a
   * million `integer` rows is not an `integer` and `Number()` on it loses digits past 2^53 — and a
   * money column answers a `MoneyValue` in integer minor units. `min`/`max` answer the row's own
   * type, because the answer is one of the values that went in.
   *
   * `null` for an empty set in every one of them, which is what SQL answers: a `0` would claim
   * rows were seen.
   *
   * Refused rather than answered: a kind with no aggregate the two drivers can agree on (`text`
   * ordering is the database's collation here and JS code-unit order there), `avg` over money
   * (every answer would be a silent rounding of a fraction of a minor unit), and an amount
   * covering more than one currency or scale.
   */
  sum<K extends keyof Row & string>(
    column: K,
  ): Promise<(Row[K] extends MoneyValue | null ? MoneyValue : string) | null>;
  avg<K extends keyof Row & string>(column: K): Promise<string | null>;
  min<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
  max<K extends keyof Row & string>(column: K): Promise<Row[K] | null>;
  /**
   * The planner's own row estimate for the table — `reltuples`, one row out of `pg_class`, and the
   * only count that stays constant time as the table grows. `count()` walks every visible row
   * because MVCC gives it no shortcut, so past a few million it is the read that trips a web
   * role's `statement_timeout` and no index can make it cheaper.
   *
   * The whole TABLE, never the chain's filters — a filtered chain is `X_APPROXIMATE_COUNT_FILTERED`
   * rather than an estimate that answers a different question than the one asked. `null` when the
   * table has never been analysed, which is the absence of an estimate and not an estimate of zero.
   */
  approximateCount(): Promise<number | null>;
  /**
   * Rows per time bucket, in the zone named — "signups per day in this person's zone" is
   * `users.where({ orgId }).series({ on: 'createdAt', unit: 'day', timeZone, value: 'count' })`,
   * one statement, under the chain's filters, tenancy and soft-delete visibility, never its page.
   *
   * `unit` is `minute`, `hour`, `day`, `week` (from Monday) or `month`, truncated as Postgres'
   * `date_trunc(unit, col, zone)` truncates — so a DST day has 23 or 25 hours and 23:30 UTC is the
   * next day in Tokyo. `value` is `'count'` or `{ sum: column }`, never a float. Ascending; a
   * bucket with no rows is absent (the range is the caller's); past `MAX_GROUPS` buckets it is
   * refused (`X_ENTITY_SERIES_INVALID`), never truncated.
   */
  series<
    On extends TimestampKeys<Row, S>,
    V extends SeriesValue<Exclude<keyof Row & string, S['sealed']>>,
  >(spec: SeriesOptions<On, V>): Promise<readonly SeriesPoint<SeriesValueOf<Row, V>>[]>;
}

/** The members of `Repo` these read, none of which names the row — so any repository fits. */
type AggregateRepo = Pick<Repo<unknown>, 'aggregate' | 'approximateCount' | 'countBy' | 'series'>;

export const readAggregates = <Row, S extends SealedKeySet>(
  entity: { readonly $name: string },
  repo: AggregateRepo,
  args: () => Parameters<Repo['count']>[0],
): ReadAggregates<Row, S> => ({
  // The one cast on each of these, and it is the same seam `select()` has: the driver contract is
  // row-agnostic because a column name is a runtime string there, while the chain knows which
  // property it just named and therefore what comes back.
  sum: async <K extends keyof Row & string>(column: K) =>
    (await repo.aggregate('sum', column, args())) as
      | (Row[K] extends MoneyValue | null ? MoneyValue : string)
      | null,
  avg: async (column: keyof Row & string) =>
    (await repo.aggregate('avg', column, args())) as string | null,
  min: async <K extends keyof Row & string>(column: K) =>
    (await repo.aggregate('min', column, args())) as Row[K] | null,
  max: async <K extends keyof Row & string>(column: K) =>
    (await repo.aggregate('max', column, args())) as Row[K] | null,

  approximateCount: () => repo.approximateCount(args()),

  countBy: async <K extends keyof Row & string>(column: K) =>
    (await repo.countBy(column, args())) as ReadonlyMap<Row[K], number>,

  series: async <On extends TimestampKeys<Row, S>, V>(spec: SeriesOptions<On, V>) => {
    if (repo.series === undefined) throw seriesUnsupported(entity.$name);
    const points = await repo.series({ ...spec, value: spec.value as SeriesValue }, args());
    return points as readonly SeriesPoint<SeriesValueOf<Row, V>>[];
  },
});
