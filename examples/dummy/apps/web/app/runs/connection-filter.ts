/**
 * The runs page's filter over its connections: a "created between" range read off the URL as two
 * `PlainDate`s, and the connections as a tree of days for `<Tree>`'s link mode. A day is a day in
 * the MEMBER's zone — handed in, never the server's — and the day labels are formatted in it too.
 */

import {
  comparePlainDates,
  instant,
  isPlainDate,
  type PlainDate,
  plainDateIn,
  plainDateToUtcInstant,
} from '@ultimat3/time';
import type { TreeNode } from '@ultimat3/ui';
import { CREATED_FROM, CREATED_TO } from './created-filter';

export interface CreatedRange {
  readonly from: PlainDate | undefined;
  readonly to: PlainDate | undefined;
}

/** Read leniently: a missing or malformed end is no bound, and a backwards pair is swapped. */
export function createdRange(url: string): CreatedRange {
  const params = new URL(url, 'http://runs.invalid').searchParams;
  const read = (name: string): PlainDate | undefined => {
    const raw = params.get(name);
    return isPlainDate(raw) ? raw : undefined;
  };
  const from = read(CREATED_FROM);
  const to = read(CREATED_TO);
  return from !== undefined && to !== undefined && comparePlainDates(to, from) < 0
    ? { from: to, to: from }
    : { from, to };
}

interface Created {
  readonly createdAt: Date | string;
}

/** The day a connection was created, in `zone`. */
export const createdOn = (row: Created, zone: string): PlainDate =>
  plainDateIn(instant(new Date(row.createdAt)), zone);

/** The rows created on a day inside the range, both ends included. */
export function withinCreated<T extends Created>(
  rows: readonly T[],
  range: CreatedRange,
  zone: string,
): readonly T[] {
  return rows.filter((row) => {
    const day = createdOn(row, zone);
    if (range.from !== undefined && comparePlainDates(day, range.from) < 0) return false;
    return range.to === undefined || comparePlainDates(day, range.to) <= 0;
  });
}

/** The page filtered to one day: what a connection's leaf in the tree links to. */
export const dayHref = (day: PlainDate): string =>
  `/runs?${new URLSearchParams({ [CREATED_FROM]: day, [CREATED_TO]: day }).toString()}`;

/**
 * Connections grouped by the day they were created, newest day first: a branch per day labelled in
 * `locale`, a leaf per connection. The day's id carries its date so a leaf's href can be found from
 * the tree alone.
 */
export function connectionsByDay(
  rows: readonly (Created & { readonly id: string; readonly label: string })[],
  zone: string,
  locale: string,
): readonly TreeNode[] {
  // `timeZone: 'UTC'` on a plain date's UTC midnight: the day named, never shifted again.
  const format = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  const days = new Map<PlainDate, TreeNode[]>();
  for (const row of rows) {
    const day = createdOn(row, zone);
    const leaves = days.get(day) ?? [];
    leaves.push({ id: row.id, label: row.label });
    days.set(day, leaves);
  }
  return [...days.entries()]
    .sort(([left], [right]) => comparePlainDates(right, left))
    .map(([day, children]) => ({
      id: `day:${day}`,
      label: format.format(plainDateToUtcInstant(day)),
      children,
    }));
}
