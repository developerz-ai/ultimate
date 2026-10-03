// Pure core behind <RelativeTime>. Uses Intl.RelativeTimeFormat against the
// injected locale; the caller supplies `now` so output is deterministic in tests
// and identical between the server render and the client hydrate.

import { type TimeInput, toDate } from './date-time-view';

export interface RelativeTimeOptions {
  value: TimeInput;
  locale: string;
  /** Defaults to the current instant. Pass it explicitly for SSR parity. */
  now?: TimeInput | undefined;
  numeric?: 'always' | 'auto' | undefined;
}

interface Threshold {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly ms: number;
}

const THRESHOLDS: readonly Threshold[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

const unitMs = (index: number): number => (THRESHOLDS[index] as Threshold).ms;
const roundIn = (delta: number, index: number): number => Math.round(delta / unitMs(index));

export function relativeTimeText(options: RelativeTimeOptions): string {
  const target = toDate(options.value).getTime();
  const base = options.now === undefined ? Date.now() : toDate(options.now).getTime();
  const delta = target - base;
  const magnitude = Math.abs(delta);

  let index = THRESHOLDS.findIndex((candidate) => magnitude >= candidate.ms);
  if (index < 0) index = THRESHOLDS.length - 1;
  // Promote AFTER rounding: 59.6 minutes rounds to 60, and "60 minutes ago" is "1 hour ago".
  while (index > 0 && Math.abs(roundIn(delta, index)) * unitMs(index) >= unitMs(index - 1)) {
    index -= 1;
  }
  const threshold = THRESHOLDS[index] as Threshold;
  const value = roundIn(delta, index);

  const formatter = new Intl.RelativeTimeFormat(options.locale, {
    numeric: options.numeric ?? 'auto',
  });
  return formatter.format(magnitude < 1000 ? 0 : value, threshold.unit);
}
