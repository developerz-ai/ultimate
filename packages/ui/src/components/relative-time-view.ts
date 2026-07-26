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

export function relativeTimeText(options: RelativeTimeOptions): string {
  const target = toDate(options.value).getTime();
  const base = options.now === undefined ? Date.now() : toDate(options.now).getTime();
  const delta = target - base;
  const magnitude = Math.abs(delta);

  const threshold =
    THRESHOLDS.find((candidate) => magnitude >= candidate.ms) ??
    (THRESHOLDS[THRESHOLDS.length - 1] as Threshold);
  const value = Math.round(delta / threshold.ms);

  const formatter = new Intl.RelativeTimeFormat(options.locale, {
    numeric: options.numeric ?? 'auto',
  });
  return formatter.format(magnitude < 1000 ? 0 : value, threshold.unit);
}
