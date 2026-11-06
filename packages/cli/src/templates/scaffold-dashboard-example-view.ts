// The `--example` dashboard's view module, `dashboard-view.ts`: the pure numbers behind the page —
// stats, per-day buckets, the chart's window presets and its day bound. Split from
// `scaffold-dashboard-example.ts`, which keeps the page that reads it.

export const exampleView =
  (): string => `// The dashboard's numbers, apart from its markup: pure functions over the rows the page loaded,
// so the server render and a test cannot disagree about a figure. No I/O, no \`t()\`, no JSX.

import type { Money } from '@ultimat3/money';
import { type ChartPoint, deltaOf, type StatDelta } from '@ultimat3/ui';

/**
 * The chart's windows, shortest first. The list is this app's — "last 24 hours" or "this quarter"
 * is a business decision — and \`timeRangeUrl\` is the one rule that reads it from the URL.
 */
export const CHART_RANGES = [
  { id: 'week', days: 7 },
  { id: 'fortnight', days: 14 },
  { id: 'month', days: 30 },
] as const;

export const DEFAULT_CHART_RANGE = 'fortnight';

/** The chart buckets UTC days, so a custom window's wall-clock times are UTC too: one zone. */
export const CHART_ZONE = 'UTC';

/** The most bars a custom window draws: one per day, so this bounds the markup a URL can ask for. */
export const CHART_MAX_DAYS = 92;

const DAY_MS = 86_400_000;

/** Whole days a window covers, at least one and at most \`CHART_MAX_DAYS\`. */
export function chartDays(from: Date, to: Date): number {
  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
  return Math.min(CHART_MAX_DAYS, Math.max(1, days));
}

/** One post as the page reads it. \`createdAt\` is ISO text: a \`Date\` cannot cross a JSON seam. */
export interface PostRow {
  readonly id: string;
  readonly title: string;
  /** Integer minor units plus an ISO code, never a float — the entity's \`money()\` column. */
  readonly price: Money;
  readonly createdAt: string;
}

/**
 * Duck-typed rather than the entity's own row: the page only ever reads these four columns. The
 * query reads through the typed handle, so \`createdAt\` arrives as the \`Date\` the entity declares.
 */
export function toPostRow(row: {
  readonly id: string;
  readonly title: string;
  readonly price: Money;
  readonly createdAt: Date | string;
}): PostRow {
  const at = row.createdAt;
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    createdAt: at instanceof Date ? at.toISOString() : at,
  };
}

/** Free (a zero price) against paid, over every row loaded — the two halves of the ring. */
export interface PriceMix {
  readonly free: number;
  readonly paid: number;
}

export function priceMix(rows: readonly PostRow[]): PriceMix {
  const paid = rows.filter((row) => row.price.minor > 0).length;
  return { free: rows.length - paid, paid };
}

/**
 * The dearest price per currency, in minor units — what each row's in-cell bar is a share of.
 * Per currency because 1,900 cents and 1,900 yen are not the same height.
 */
export function priceCeilings(rows: readonly PostRow[]): ReadonlyMap<string, number> {
  const ceilings = new Map<string, number>();
  for (const row of rows) {
    const { currency, minor } = row.price;
    ceilings.set(currency, Math.max(ceilings.get(currency) ?? 0, minor));
  }
  return ceilings;
}

export interface PostStats {
  readonly total: number;
  /** Created in the seven days ending at \`now\`. */
  readonly lastWeek: number;
  /** \`lastWeek\` against the seven days before it: a percentage, or the difference from zero. */
  readonly delta: StatDelta | undefined;
  /** Created in the UTC day \`now\` falls in — a partial day, so it carries no delta. */
  readonly today: number;
}

const createdAtOf = (row: PostRow): number => Date.parse(row.createdAt);

const within = (rows: readonly PostRow[], from: number, to: number): number =>
  rows.filter((row) => {
    const at = createdAtOf(row);
    return Number.isFinite(at) && at > from && at <= to;
  }).length;

export function postStats(rows: readonly PostRow[], now: Date): PostStats {
  const end = now.getTime();
  const weekAgo = end - 7 * DAY_MS;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastWeek = within(rows, weekAgo, end);
  return {
    total: rows.length,
    lastWeek,
    delta: deltaOf(lastWeek, within(rows, weekAgo - 7 * DAY_MS, weekAgo)),
    today: within(rows, dayStart - 1, end),
  };
}

/** \`MM-DD\` of a UTC day. ISO, never \`toLocaleDateString\`: the chart's axis is data, not prose. */
const dayKey = (at: number): string => new Date(at).toISOString().slice(5, 10);

/**
 * One bucket per UTC day, the last one being the day \`now\` falls in, oldest first — the shape
 * \`BarChart\` draws. Every day is present even when nothing was created on it: a chart with the
 * quiet days removed reads as busier than the app is. A quiet day is 0; a day the read could not
 * see — before the oldest row of a \`capped\` read — is \`null\`, a gap, never a zero.
 */
export function bucketByDay(
  rows: readonly PostRow[],
  now: Date,
  days: number,
  options: { readonly capped?: boolean } = {},
): readonly ChartPoint[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (days - 1) * DAY_MS;
  const counts: number[] = Array.from({ length: days }, () => 0);
  for (const row of rows) {
    const at = createdAtOf(row);
    if (!Number.isFinite(at)) continue;
    const index = Math.floor((at - start) / DAY_MS);
    if (index >= 0 && index < days) counts[index] = (counts[index] ?? 0) + 1;
  }
  const oldest = Math.min(...rows.map(createdAtOf).filter(Number.isFinite));
  const seenFrom = options.capped === true ? Math.floor((oldest - start) / DAY_MS) : 0;
  return counts.map((value, index) => ({
    key: dayKey(start + index * DAY_MS),
    value: index < seenFrom ? null : value,
  }));
}

/** A figure for a tile, in the page's locale. \`Intl.NumberFormat\` needs no time zone. */
export const formatCount = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale).format(value);
`;
