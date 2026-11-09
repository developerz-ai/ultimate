// A date range's rules: which end a pick sets, a backwards pair swapped, and where a day sits in
// the span (`aria-selected` covers it all). Pure over `PlainDate`, so `DateRangePicker` is wiring.

import { comparePlainDates, type PlainDate } from '@ultimat3/time';

export interface DateRange {
  readonly from?: PlainDate | undefined;
  readonly to?: PlainDate | undefined;
}

export type SpanPosition = 'start' | 'end' | 'inside';

/** Ends in order: a `to` before its `from` is the same span read the other way. */
export function orderedRange(range: DateRange): DateRange {
  const { from, to } = range;
  if (from !== undefined && to !== undefined && comparePlainDates(to, from) < 0) {
    return { from: to, to: from };
  }
  return range;
}

/**
 * The first pick starts a range, the second completes it — either side of the first, swapped into
 * order. A pick after a complete range starts the next one.
 */
export function pickRange(
  range: DateRange,
  picked: PlainDate,
): { readonly range: DateRange; readonly complete: boolean } {
  if (range.from === undefined || range.to !== undefined) {
    return { range: { from: picked, to: undefined }, complete: false };
  }
  return { range: orderedRange({ from: range.from, to: picked }), complete: true };
}

/** Where `date` sits in the span, `undefined` outside it. One end alone is its own start. */
export function spanPosition(date: PlainDate, range: DateRange): SpanPosition | undefined {
  const { from, to } = orderedRange(range);
  if (from === undefined) return undefined;
  if (date === from) return 'start';
  if (to === undefined) return undefined;
  if (date === to) return 'end';
  return comparePlainDates(date, from) > 0 && comparePlainDates(date, to) < 0
    ? 'inside'
    : undefined;
}
