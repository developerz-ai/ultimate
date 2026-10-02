// Single responsibility: a `timestamptz` value at the precision the COLUMN stores it, rather than
// the precision a JS `Date` holds. The column keeps microseconds and a `Date` keeps milliseconds,
// so a page position minted from a decoded row ranks rows differently from the `order by` that
// produced them. Microseconds since the epoch is the one form both sides can be exact in, and this
// file is the only place the two representations meet.

/** A `Date` is exactly this much coarser than the column it came out of. */
const MICROS_PER_MILLI = 1000n;

const MICROS_PER_SECOND = 1_000_000n;

const FRACTION_DIGITS = 6;

/**
 * What `(col at time zone 'UTC')::text` prints: `2026-01-01 00:00:00.123456`, with the fraction
 * omitted entirely when every digit of it is zero and TRUNCATED when the trailing ones are —
 * `.1` is a tenth of a second, not one microsecond, which is why the fraction is padded on the
 * right and never on the left.
 *
 * The year is `\d{4,}` because Postgres prints one wider than four digits unpadded; a `BC` suffix
 * matches nothing here on purpose, and an unmatched text falls back to the decoded `Date`.
 */
const PG_INSTANT_TEXT = /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;

/**
 * `Date.UTC` maps years 0–99 into the 1900s, so the epoch is built by assignment instead. Whole
 * seconds only: the fraction is added in the microsecond domain, where it is exact.
 */
const utcSecondMillis = (parts: readonly number[]): number => {
  const [year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0] = parts;
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hour, minute, second, 0);
  return at.getTime();
};

/** Floor division: `-1n / 2n` truncates toward zero, which would place a pre-1970 instant late. */
const floorDiv = (value: bigint, by: bigint): bigint => {
  const remainder = ((value % by) + by) % by;
  return (value - remainder) / by;
};

/**
 * The exact microsecond epoch of a `timestamptz` Postgres rendered as text, or `undefined` when
 * the text is not one — a caller with nothing to read falls back to the decoded `Date`, which is
 * the position it always had.
 */
export const pgInstantMicros = (text: unknown): bigint | undefined => {
  if (typeof text !== 'string') return undefined;
  const match = PG_INSTANT_TEXT.exec(text);
  if (match === null) return undefined;
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', fraction] = match;
  const millis = utcSecondMillis([year, month, day, hour, minute, second].map(Number));
  if (!Number.isFinite(millis)) return undefined;
  // The fraction is always forward in time, so it ADDS even when the second boundary is negative.
  return BigInt(millis) * MICROS_PER_MILLI + BigInt((fraction ?? '').padEnd(FRACTION_DIGITS, '0'));
};

/**
 * An instant as TEXT that names its own zone — what `toISOString()` writes and what a URL, a JSON
 * body or a hand-kept keyset position holds: `2026-01-01T00:00:03.000Z`, `…+02:00`, `… 00:00:03+00`.
 *
 * The zone is REQUIRED. Postgres reads a zoneless text in the session's `TimeZone`, which this
 * process cannot know, so such a text is not an instant here — the same rule `timestamp()` holds a
 * written value to.
 */
const ISO_INSTANT_TEXT =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

const MICROS_PER_MINUTE = 60_000_000n;

const MICROS_PER_DAY = 86_400_000_000;

/** Postgres's `MAX_TZDISP_HOUR`: a numeric offset of sixteen hours or more is an error there. */
const MAX_OFFSET_HOURS = 15;

/** `Z`, `+02`, `+02:00`, `-0430` → minutes east of UTC; `undefined` past what Postgres accepts. */
const offsetMinutes = (zone: string): bigint | undefined => {
  if (zone.toUpperCase() === 'Z') return 0n;
  const digits = zone.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = Number(digits.slice(2) || '0');
  if (hours > MAX_OFFSET_HOURS || minutes >= 60) return undefined;
  const east = BigInt(hours * 60 + minutes);
  return zone.startsWith('-') ? -east : east;
};

/**
 * The fraction as Postgres reads it: `strtod` of the digits, times a million, `rint` — so past six
 * digits it ROUNDS, half to even, on the double (`.0000005` is a hair under the half and goes
 * down), and `.9999996` is a whole second. JavaScript's `Number` is the same IEEE double.
 */
const fractionMicros = (digits: string | undefined): number => {
  if (digits === undefined) return 0;
  if (digits.length <= FRACTION_DIGITS) return Number(digits.padEnd(FRACTION_DIGITS, '0'));
  const scaled = Number(`0.${digits}`) * 1_000_000;
  const floor = Math.floor(scaled);
  const above = scaled - floor;
  if (above !== 0.5) return above > 0.5 ? floor + 1 : floor;
  return floor % 2 === 0 ? floor : floor + 1;
};

/**
 * The exact microsecond epoch an ISO instant text names, or `undefined` when Postgres would refuse
 * it — no zone, a date the calendar does not have (`2026-13-45` is an error there, never the 14th
 * of February), an offset of sixteen hours, or a time past the end of its day.
 *
 * Postgres's `time_overflows`: hour ≤ 24, minute ≤ 59, second ≤ 60, and the whole time of day at
 * most 24:00:00 — so `24:00:00` is the next midnight and `:60` the next minute, while
 * `24:00:00.000001` and `23:59:60.5` are errors.
 */
const isoInstantMicros = (text: string): bigint | undefined => {
  const match = ISO_INSTANT_TEXT.exec(text);
  if (match === null) return undefined;
  const [, year = '', month = '', day = '', hour = '', minute = '', second = '', fraction] = match;
  const [y = 0, m = 0, d = 0] = [year, month, day].map(Number);
  const [h = 0, min = 0, sec = 0] = [hour, minute, second].map(Number);
  const midnight = utcSecondMillis([y, m, d, 0, 0, 0]);
  const built = new Date(midnight);
  // A field the calendar rolled over was never that date: 13 months, 45 days.
  if (built.getUTCMonth() + 1 !== m || built.getUTCDate() !== d) return undefined;
  const fsec = fractionMicros(fraction);
  const ofDay = ((h * 60 + min) * 60 + sec) * 1_000_000 + fsec;
  if (h > 24 || min > 59 || sec > 60 || ofDay > MICROS_PER_DAY) return undefined;
  const offset = offsetMinutes(match[8] ?? 'Z');
  if (offset === undefined) return undefined;
  const local = BigInt(midnight) * MICROS_PER_MILLI + BigInt(ofDay);
  // The text is wall-clock time AT its offset, so the instant is that many minutes earlier.
  return local - offset * MICROS_PER_MINUTE;
};

/**
 * The microsecond epoch of whatever a sort key or an operand is holding: a decoded row's `Date`
 * (milliseconds, so the last three digits are zero), a value already counted in microseconds, the
 * decimal a cursor carries, or an ISO instant as text. `undefined` for anything else, so a caller
 * decides rather than guessing at `0`.
 *
 * The ISO text is the half Postgres always had: a `"created_at" < $1` bound to
 * `2026-01-01T00:00:03.000Z` is parsed there as an instant, while the in-memory driver compared it
 * to the stored `Date` by CHARACTERS — so a hand-kept keyset answered an empty page two in memory
 * and the right one in production.
 */
export const instantMicros = (value: unknown): bigint | undefined => {
  if (typeof value === 'bigint') return value;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? undefined : BigInt(millis) * MICROS_PER_MILLI;
  }
  if (typeof value !== 'string') return undefined;
  return /^-?\d+$/.test(value) ? BigInt(value) : isoInstantMicros(value);
};

/**
 * The instant a seek binds, spelled so Postgres parses it back to the same microsecond. ISO 8601
 * in UTC with all six fraction digits — `toISOString()` alone is milliseconds, which is the whole
 * defect this file exists to close, so the fraction is written here rather than read off the
 * `Date`.
 */
export const microsToIso = (micros: bigint): string => {
  const second = floorDiv(micros, MICROS_PER_SECOND);
  const fraction = micros - second * MICROS_PER_SECOND;
  const whole = new Date(Number(second) * 1000).toISOString();
  return `${whole.slice(0, whole.indexOf('.'))}.${String(fraction).padStart(FRACTION_DIGITS, '0')}Z`;
};

/**
 * The output name the microsecond half of a sort key comes back under. Every physical column name
 * in this framework is lower case — `columnName` is either `snake(property)`, which lower-cases,
 * or a `.column()` name `assertColumnName` refuses unless it matches `[a-z_][a-z0-9_$]*` — so an
 * UPPER-CASE suffix is a name no entity can declare and this alias can never shadow a column.
 */
export const SEEK_ALIAS_SUFFIX = '$US';

export const seekAlias = (physicalColumn: string): string =>
  `${physicalColumn}${SEEK_ALIAS_SUFFIX}`;
