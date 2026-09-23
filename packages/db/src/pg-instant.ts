// Single responsibility: Postgres' TEXT form of `timestamptz` and `timestamp`, read as an instant.
// PGlite's own parser — and Bun.SQL's on the text protocol — read year `0099` as 1999, and under a
// session zone that is not UTC answered Invalid Date for an offset carrying seconds (local mean
// time before a zone's standard time: `-04:56:02`), which `@ultimat3/entity` then refused as
// `X_INVARIANT_VIOLATED` on a whole-row read. One reader, every field explicit, no `Date.parse`.

/** The two instants `new Date` can hold at the ends of its range — what `±infinity` reads as. */
const FAR_FUTURE_MS = 8.64e15;

/**
 * `YYYY-MM-DD HH:MM:SS[.frac][±HH[:MM[:SS]]][ BC]` — the ISO DateStyle output, the default and the
 * only one a framework connection runs under. The year is four or more digits, never two.
 */
const PG_TIMESTAMP =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( BC)?$/;

const number = (text: string | undefined): number => (text === undefined ? 0 : Number(text));

function parse(text: string, zoned: boolean): Date {
  if (text === 'infinity') return new Date(FAR_FUTURE_MS);
  if (text === '-infinity') return new Date(-FAR_FUTURE_MS);
  const match = PG_TIMESTAMP.exec(text);
  // Not a form this reader knows: Invalid Date, exactly what the drivers answered — a caller that
  // validates (every entity column does) refuses it loudly rather than storing a guess.
  if (match === null) return new Date(Number.NaN);
  const [, year, month, day, hour, minute, second, fraction, sign, offH, offM, offS, bc] = match;
  // Astronomical year: 1 BC is 0, 44 BC is -43.
  const astronomical = bc === undefined ? number(year) : 1 - number(year);
  const millis = Math.floor(number((fraction ?? '').padEnd(3, '0').slice(0, 3)));
  const at = new Date(0);
  // `setUTCFullYear`, never `Date.UTC(year, …)`: the latter maps 0-99 onto 1900-1999, which is the
  // defect this file exists for.
  at.setUTCFullYear(astronomical, number(month) - 1, number(day));
  at.setUTCHours(number(hour), number(minute), number(second), millis);
  if (!zoned || sign === undefined) return at;
  const offsetMs = ((number(offH) * 60 + number(offM)) * 60 + number(offS)) * 1_000;
  return new Date(at.getTime() - (sign === '-' ? -offsetMs : offsetMs));
}

/** `timestamptz` text: the offset it carries decides the instant. */
export const parsePgTimestamptz = (text: string): Date => parse(text, true);

/** `timestamp` text: no zone, so UTC — never the host process's zone, which is what `new Date` uses. */
export const parsePgTimestamp = (text: string): Date => parse(text, false);

/** Postgres type oids for the two. PGlite takes its parsers keyed by oid. */
export const TIMESTAMPTZ_OID = 1184;
export const TIMESTAMP_OID = 1114;

/** What `pglite.ts` hands the embedded driver, so it never reads an instant through its own parser. */
export const PGLITE_INSTANT_PARSERS = Object.freeze<Record<number, (text: string) => unknown>>({
  [TIMESTAMPTZ_OID]: parsePgTimestamptz,
  [TIMESTAMP_OID]: parsePgTimestamp,
});
