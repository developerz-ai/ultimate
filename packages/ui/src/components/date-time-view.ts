// Pure formatting core behind <DateTime>. Produces both halves the component
// needs: the machine-readable ISO instant for `<time datetime>` and the human
// string formatted in the injected zone + locale.

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
