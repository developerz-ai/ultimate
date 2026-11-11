// Single responsibility: where a seeded `partitionBy` column's values may land: the UTC bucket
// holding the anchor (`date_trunc(unit, … at time zone 'UTC')`, as `ultimate_partitions` cuts it),
// read off the entity's own `$describe().partition` — never a date of ours.
//
// Storable while the database's partitions cover the anchor: the migration makes them around its
// APPLY time and only the app's `partitions()` job keeps them ahead; past that, the seed pass
// refuses naming that job.

import type { PartitionDescription } from '@ultimat3/entity';

/** One UTC bucket: `[startMs, startMs + spanMs)`. */
export interface PartitionWindow {
  readonly startMs: number;
  readonly spanMs: number;
}

const DAY = 86_400_000;

/** `date_trunc(unit, anchor at time zone 'UTC')` and the bucket's length, as Postgres reads both. */
export function partitionWindow(
  partition: PartitionDescription | null | undefined,
  anchor: Date,
): PartitionWindow | null {
  if (partition === null || partition === undefined) return null;
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const today = Date.UTC(y, m, anchor.getUTCDate());
  switch (partition.interval) {
    case 'day':
      return { startMs: today, spanMs: DAY };
    case 'week':
      // ISO: a week starts on a Monday, as `date_trunc('week', …)` does. getUTCDay(): Sunday is 0.
      return { startMs: today - ((anchor.getUTCDay() + 6) % 7) * DAY, spanMs: 7 * DAY };
    case 'month':
      return { startMs: Date.UTC(y, m, 1), spanMs: Date.UTC(y, m + 1, 1) - Date.UTC(y, m, 1) };
    case 'year':
      return { startMs: Date.UTC(y, 0, 1), spanMs: Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1) };
  }
}

/** How many distinct values one row is offered: enough for the row solver to step past a unique. */
const OFFERED = 8;

/**
 * Candidates for one row's partition column, every one inside `window`: instants for a
 * `timestamptz`, `YYYY-MM-DD` for a `date`, rotated by the row's ordinal so rows spread over the
 * bucket. Any other kind is no partition bound this reads — none of its own, the kind's own apply.
 */
export function valuesInWindow(
  kind: string,
  window: PartitionWindow,
  ordinal: number,
  position: number,
): readonly unknown[] {
  if (kind === 'date') {
    const days = Math.max(1, Math.floor(window.spanMs / DAY));
    return Array.from({ length: Math.min(OFFERED, days) }, (_, i) =>
      new Date(window.startMs + ((ordinal + i) % days) * DAY).toISOString().slice(0, 10),
    );
  }
  if (kind === 'timestamptz') {
    const minutes = Math.floor(window.spanMs / 60_000);
    return Array.from(
      { length: OFFERED },
      (_, i) => new Date(window.startMs + ((ordinal * 7 + position + i) % minutes) * 60_000),
    );
  }
  return [];
}
