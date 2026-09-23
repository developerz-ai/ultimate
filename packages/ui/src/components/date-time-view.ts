// Pure formatting core behind <DateTime>. Produces both halves the component
// needs: the machine-readable ISO instant for `<time datetime>` and the human
// string formatted in the injected zone + locale.

import { isIsoDateTime } from '@ultimat3/core';
import {
  type DateTimeStyle,
  type FormatDateTimeOptions,
  formatDateTime,
  type Instant,
  instant,
  type TimeZone,
} from '@ultimat3/time';
import { invalidValueError } from '../errors';

/** What a component may be handed for a point in time. */
export type TimeInput = Date | string | number | Instant;

export type DateStyle = DateTimeStyle;

export type DateTimeFormatter = (at: Instant, options: FormatDateTimeOptions) => string;

export interface DateTimeViewOptions {
  value: TimeInput;
  /** Required: there is no ambient locale in this package. */
  locale: string;
  /** Required: a date is never formatted without an explicit IANA zone. */
  timeZone: TimeZone;
  dateStyle?: DateStyle | undefined;
  timeStyle?: DateStyle | undefined;
  /** Override for tests or a custom calendar. */
  format?: DateTimeFormatter | undefined;
}

export interface DateTimeView {
  /** UTC ISO-8601 — the value that goes in the `datetime` attribute. */
  readonly dateTime: string;
  /** Localised, zoned text — the value a human reads. */
  readonly text: string;
}

export function toDate(value: TimeInput): Date {
  // `new Date('2026-08-14T09:00')` resolves in the HOST's zone — the one ambient default this
  // package forbids, inside the one function that had it. It rendered `09:00` on a `TZ=UTC` runner
  // and `00:00` on `TZ=Asia/Tokyo` with the same `timeZone="UTC"` prop and no error. Every
  // FORMATTING path here was already zoned; only the parse was not.
  //
  // The predicate is `@ultimat3/schema`'s — the one `t.date` and `timestamp()` use — so a string is
  // ISO-8601 in SHAPE as well as zoned: `'August 14, 2026 09:00'` and `'8/14/2026'` were not
  // "ISO-shaped offset-less" and walked past a narrower local guard into `new Date`, in the host zone.
  if (typeof value === 'string' && !isIsoDateTime(value)) {
    throw invalidValueError(
      'DateTime',
      value,
      'an ISO-8601 string: a date (2026-08-14) or a date-time carrying Z or a ±HH:MM offset',
    );
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw invalidValueError('DateTime', value, 'a valid Date, ISO string, or epoch millis');
  }
  return date;
}

export function toInstant(value: TimeInput): Instant {
  return instant(toDate(value));
}

/** Always UTC, so the attribute is comparable across zones and machines. */
export function toIsoInstant(value: TimeInput): string {
  return toDate(value).toISOString();
}

export function dateTimeView(view: DateTimeViewOptions): DateTimeView {
  const at = toInstant(view.value);
  const format = view.format ?? formatDateTime;
  const options: FormatDateTimeOptions = {
    locale: view.locale,
    zone: view.timeZone,
    ...(view.dateStyle === undefined ? {} : { dateStyle: view.dateStyle }),
    ...(view.timeStyle === undefined ? {} : { timeStyle: view.timeStyle }),
  };
  return { dateTime: at.toISOString(), text: format(at, options) };
}
