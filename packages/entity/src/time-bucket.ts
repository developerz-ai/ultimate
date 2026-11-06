// Single responsibility: what a time series is made of — the closed list of units, the zone check,
// the bucket ceiling, and the one in-memory truncation Postgres' three-argument `date_trunc` is
// matched against. Both drivers read the rules from here, as `count-by.ts` is read for a grouped
// count, so a `series` against memory buckets a row exactly where Postgres buckets it.

import { renderFixShellArg } from '@ultimat3/core';
import { assertTimeZone, fromZoned, instant, isValidTimeZone, toZoned } from '@ultimat3/time';
import { aggregateColumnOf } from './aggregate';
import { columnFor } from './column';
import { MAX_GROUPS } from './count-by';
import type { EntityCore } from './entity';
import { EntityError } from './entity-error';
import type { AnyColumn } from './types';

/** Closed. A week starts on Monday, as `date_trunc('week', …)` starts one. */
export const SERIES_UNITS = ['minute', 'hour', 'day', 'week', 'month'] as const;
export type SeriesUnit = (typeof SERIES_UNITS)[number];

/** `'count'` per bucket, or one column summed per bucket — `aggregate.ts`'s `sum`, never a float. */
export type SeriesValue<K extends string = string> = 'count' | { readonly sum: K };

/** The row-agnostic request a driver answers; `ReadBuilder.series` is the typed spelling. */
export interface SeriesSpec {
  readonly on: string;
  readonly unit: SeriesUnit;
  /** IANA, required: a bucket in the session's zone is a bucket in nobody's. */
  readonly timeZone: string;
  readonly value: SeriesValue;
}

/** One bucket that holds rows. A bucket with none is absent — the range is the caller's. */
export interface SeriesPoint<V = unknown> {
  /** The bucket's first instant: local midnight, the local hour, the local Monday… */
  readonly bucket: Date;
  readonly value: V;
}

/** A spec both drivers have judged: the zone canonical, the columns resolved. */
export interface SeriesPlan {
  readonly on: string;
  readonly unit: SeriesUnit;
  readonly timeZone: string;
  readonly sum: { readonly property: string; readonly column: AnyColumn } | null;
}

const UNITS: ReadonlySet<string> = new Set(SERIES_UNITS);

const seriesInvalid = (entityName: string, detail: string, fix: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_SERIES_INVALID',
    cause: `${entityName}.series(): ${detail}`,
    fix,
  });

const timestampColumns = <Row>(entity: EntityCore<Row>): readonly string[] =>
  Object.entries(entity.$columns)
    .filter(([, column]) => column.$meta.kind === 'timestamptz')
    .map(([property]) => property);

/**
 * The spec, judged before any statement exists — by the same function in both drivers, so a
 * `date()` column or `'EST'` is refused with the same words whichever one is attached.
 */
export const seriesPlanOf = <Row>(entity: EntityCore<Row>, spec: SeriesSpec): SeriesPlan => {
  const name = entity.$name;
  const [first = 'createdAt'] = timestampColumns(entity);
  const example = `${name}.series({ on: '${first}', unit: 'day', timeZone: 'Europe/Berlin', value: 'count' })`;
  if (!UNITS.has(spec.unit)) {
    throw seriesInvalid(
      name,
      `unit '${String(spec.unit)}' is not one of ${SERIES_UNITS.join(', ')}`,
      `${example}   # unit is one of: ${SERIES_UNITS.join(', ')}`,
    );
  }
  const on: AnyColumn | undefined = columnFor(entity.$columns, spec.on);
  if (on?.$meta.kind !== 'timestamptz') {
    throw seriesInvalid(
      name,
      on === undefined
        ? `no column "${spec.on}" on ${name}`
        : `"${spec.on}" is a ${on.$meta.kind} column, and a bucket is a span of instants`,
      timestampColumns(entity).length === 0
        ? `x entities show ${renderFixShellArg(name, '<entity>')} --json   # this entity declares no timestamp() column to bucket by`
        : `${example}   # on is one of: ${timestampColumns(entity).join(', ')}`,
    );
  }
  if (typeof spec.timeZone !== 'string' || !isValidTimeZone(spec.timeZone)) {
    throw seriesInvalid(
      name,
      `timeZone ${JSON.stringify(String(spec.timeZone))} is not an IANA zone`,
      `${example}   # an IANA zone such as Europe/Berlin or Asia/Tokyo, never an abbreviation or an offset`,
    );
  }
  const value = spec.value;
  const sum =
    value === 'count'
      ? null
      : { property: value.sum, column: aggregateColumnOf(entity, 'sum', value.sum) };
  return { on: spec.on, unit: spec.unit, timeZone: assertTimeZone(spec.timeZone), sum };
};

const MINUTE_MS = 60_000;

/**
 * The bucket an instant falls in, as Postgres' `date_trunc(unit, ts, zone)` answers it — measured
 * on 18, the rule is two rules:
 *
 * - `minute`/`hour` truncate the wall clock and keep the instant's OWN offset, so the repeated hour
 *   of a fall-back day is two buckets, and a `+05:30` zone's hour starts at :30 UTC.
 * - `day`/`week`/`month` truncate to local midnight and resolve it afresh: a midnight that does
 *   not exist is read at the offset before the jump (`gap: 'next'`), and one that happens twice at
 *   the offset after it (`overlap: 'second'`) — Asia/Gaza's 2016-10-29 starts at 22:00Z.
 */
export const bucketStart = (at: Date, unit: SeriesUnit, timeZone: string): Date => {
  const zoned = toZoned(instant(at), timeZone);
  if (unit === 'minute' || unit === 'hour') {
    // The wall clock's own fields, subtracted from the instant: the offset never moves, which is
    // the rule, and a zone off the minute (pre-1972 Monrovia) is read at its real offset.
    const within = zoned.second * 1000 + zoned.millisecond;
    return new Date(at.getTime() - within - (unit === 'hour' ? zoned.minute * MINUTE_MS : 0));
  }
  const day = unit === 'week' ? zoned.day - (zoned.weekday - 1) : unit === 'month' ? 1 : zoned.day;
  return fromZoned({ year: zoned.year, month: zoned.month, day, hour: 0, minute: 0 }, timeZone, {
    gap: 'next',
    overlap: 'second',
  });
};

/**
 * The points both drivers hand back: ascending by bucket, refused past the ceiling. The statement
 * asks for one bucket more than `MAX_GROUPS`, and that one is a refusal rather than a dropped tail:
 * a chart missing its last thousand days reads exactly like a complete one.
 */
export const seriesFrom = <Row>(
  entity: EntityCore<Row>,
  plan: SeriesPlan,
  points: readonly SeriesPoint[],
): readonly SeriesPoint[] => {
  if (points.length > MAX_GROUPS) {
    throw seriesInvalid(
      entity.$name,
      `more than ${MAX_GROUPS} ${plan.unit} buckets matched — that is a report, not a chart`,
      `${entity.$name}.andWhere('${plan.on}', 'gte', <from>).series({ on: '${plan.on}', unit: '${plan.unit}', … })   # bound the range, or a wider unit`,
    );
  }
  return [...points].sort((left, right) => left.bucket.getTime() - right.bucket.getTime());
};
