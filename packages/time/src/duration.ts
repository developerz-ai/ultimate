/**
 * Durations as milliseconds, parsed from a human string.
 * `step.sleep('3d')` in @ultimat3/jobs and every `retry.backoff` value comes through here.
 */

import { durationInvalid } from './errors';

export const MS = 1;
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const WEEK = 7 * DAY;

/** Accepted suffixes. `m` is minutes and `ms` is milliseconds — never months. */
const UNITS: Readonly<Record<string, number>> = {
  ms: MS,
  s: SECOND,
  sec: SECOND,
  m: MINUTE,
  min: MINUTE,
  h: HOUR,
  hr: HOUR,
  d: DAY,
  w: WEEK,
};

const COMPONENT = /(\d+(?:\.\d+)?)\s*(ms|sec|min|hr|[smhdw])\s*/iy;
const ISO_8601 = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * `'90s'` → 90000 · `'2h30m'` → 9000000 · `'3d'` → 259200000 · `'PT2H30M'` → 9000000.
 * A bare number is rejected: `sleep(3)` is ambiguous, `sleep('3s')` is not.
 */
export function parseDuration(input: string): number {
  const value = input.trim();
  if (value === '') throw durationInvalid(input);

  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;

  if (/^p/i.test(body)) return (negative ? -1 : 1) * parseIso8601Duration(body, input);

  COMPONENT.lastIndex = 0;
  let total = 0;
  let matched = 0;
  let match = COMPONENT.exec(body);
  while (match !== null) {
    const amount = Number.parseFloat(match[1] ?? '');
    const unit = (match[2] ?? '').toLowerCase();
    const scale = UNITS[unit];
    if (!Number.isFinite(amount) || scale === undefined) throw durationInvalid(input);
    total += amount * scale;
    matched = COMPONENT.lastIndex;
    match = COMPONENT.exec(body);
  }
  // Sticky matching starts at 0, so anything short of the end is trailing junk, and a
  // zero-length match means there was no unit at all (`'3'` must not mean 3 of anything).
  if (matched === 0 || matched !== body.length) throw durationInvalid(input);
  return (negative ? -1 : 1) * Math.round(total);
}

/** Parse-or-passthrough for APIs that accept either form. */
export function toMs(duration: string | number): number {
  return typeof duration === 'number' ? duration : parseDuration(duration);
}

export function toSeconds(duration: string | number): number {
  return Math.round(toMs(duration) / SECOND);
}

export interface FormatDurationOptions {
  /** Largest unit count to show: `2h 30m` with 2, `2h` with 1. */
  maxUnits?: number;
  style?: 'long' | 'short' | 'narrow';
}

const FORMAT_UNITS: readonly [string, number][] = [
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
  ['millisecond', MS],
];

/**
 * `formatDuration(9_000_000, 'de-DE')` → `2 Std., 30 Min.`
 * Built from `Intl.NumberFormat` unit style + `Intl.ListFormat`, so unit names and the
 * list separator are both localized. `Intl.DurationFormat` is not yet everywhere.
 */
export function formatDuration(
  ms: number,
  locale: string,
  options: FormatDurationOptions = {},
): string {
  const style = options.style ?? 'short';
  const maxUnits = options.maxUnits ?? 2;
  let remaining = Math.abs(Math.round(ms));
  const pieces: string[] = [];

  for (const [unit, scale] of FORMAT_UNITS) {
    if (pieces.length >= maxUnits) break;
    const count = Math.floor(remaining / scale);
    if (count === 0) continue;
    remaining -= count * scale;
    pieces.push(
      new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: style }).format(count),
    );
  }

  if (pieces.length === 0) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'second',
      unitDisplay: style,
    }).format(0);
  }

  const joined = new Intl.ListFormat(locale, { style: 'narrow', type: 'unit' }).format(pieces);
  return ms < 0 ? `-${joined}` : joined;
}

/** `PT2H30M` — for OpenAPI schemas and cron metadata. */
export function formatDurationIso(ms: number): string {
  const total = Math.abs(Math.round(ms));
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  const seconds = (total % MINUTE) / SECOND;
  const date = days > 0 ? `${days}D` : '';
  const time = [
    hours > 0 ? `${hours}H` : '',
    minutes > 0 ? `${minutes}M` : '',
    seconds > 0 ? `${seconds}S` : '',
  ].join('');
  const body = `${date}${time === '' ? '' : `T${time}`}`;
  return `${ms < 0 ? '-' : ''}P${body === '' ? '0D' : body}`;
}

function parseIso8601Duration(body: string, original: string): number {
  const match = ISO_8601.exec(body);
  if (match === null) throw durationInvalid(original);
  const [, weeks, days, hours, minutes, seconds] = match;
  const total =
    number(weeks) * WEEK +
    number(days) * DAY +
    number(hours) * HOUR +
    number(minutes) * MINUTE +
    number(seconds) * SECOND;
  if (total === 0 && body.toUpperCase() !== 'P0D') throw durationInvalid(original);
  return Math.round(total);
}

function number(value: string | undefined): number {
  return value === undefined ? 0 : Number.parseFloat(value);
}
