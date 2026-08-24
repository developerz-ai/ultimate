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
 * The microsecond epoch of whatever a sort key is holding: a decoded row's `Date` (milliseconds,
 * so the last three digits are zero), a value already counted in microseconds, or the decimal a
 * cursor carries. `undefined` for anything else, so a caller decides rather than guessing at `0`.
 */
export const instantMicros = (value: unknown): bigint | undefined => {
  if (typeof value === 'bigint') return value;
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? undefined : BigInt(millis) * MICROS_PER_MILLI;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
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
export const seekAlias = (physicalColumn: string): string => `${physicalColumn}$US`;
