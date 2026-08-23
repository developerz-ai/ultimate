// One physical value off the WAL, decoded. The claim under test is narrow and load-bearing: the
// value a `timestamptz`, an array or a `bytea` column produces here is the value the repository
// produces for the same row — not postgres' own text, which `compareValues` orders against a
// `Date`'s epoch number and which `post.tags.map(…)` throws on.

import { describe, expect, test } from 'bun:test';
import { arrayElementOid, parsePgArray } from './pg-array';
import { decodeValue } from './pg-values';

const TIMESTAMPTZ = 1184;
const TIMESTAMP = 1114;
const DATE = 1082;
const BYTEA = 17;
const TEXT_ARRAY = 1009;
const INT4_ARRAY = 1007;
const TIMESTAMPTZ_ARRAY = 1185;

describe('unit · instants', () => {
  test('postgres text becomes the Date the repository would hand back', () => {
    const value = decodeValue(TIMESTAMPTZ, '2026-08-09 12:00:00+00');
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  test('the JSON form is byte-identical to the one a snapshot frame carries', () => {
    // The convergence claim: a patch frame renders the instant exactly as a snapshot frame does,
    // because both hold the same object by the time `JSON.stringify` sees it.
    const live = decodeValue(TIMESTAMPTZ, '2026-08-09 12:00:00.123456+00');
    expect(JSON.stringify(live)).toBe(JSON.stringify(new Date('2026-08-09T12:00:00.123Z')));
  });

  test('a non-UTC offset is read at its offset, in either spelling postgres writes', () => {
    const colon = decodeValue(TIMESTAMPTZ, '2026-08-09 12:00:00+05:30');
    const bare = decodeValue(TIMESTAMPTZ, '2026-08-09 12:00:00+0530');
    const hours = decodeValue(TIMESTAMPTZ, '2026-08-09 12:00:00+05');
    expect((colon as Date).toISOString()).toBe('2026-08-09T06:30:00.000Z');
    expect((bare as Date).toISOString()).toBe('2026-08-09T06:30:00.000Z');
    expect((hours as Date).toISOString()).toBe('2026-08-09T07:00:00.000Z');
  });

  test('an offsetless timestamp is read as UTC, never as the process zone', () => {
    const value = decodeValue(TIMESTAMP, '2026-08-09 12:00:00');
    expect((value as Date).toISOString()).toBe('2026-08-09T12:00:00.000Z');
  });

  test('a value this decoder does not describe keeps the text it arrived as', () => {
    // `infinity` and a BC date are real column values and neither is an instant a `Date` holds.
    expect(decodeValue(TIMESTAMPTZ, 'infinity')).toBe('infinity');
    expect(decodeValue(TIMESTAMPTZ, '0044-03-15 00:00:00+00 BC')).toBe('0044-03-15 00:00:00+00 BC');
  });

  test('a calendar date stays the YYYY-MM-DD string date() parses to', () => {
    // `PlainDate` IS that string, so converting it to a `Date` would be the reinterpretation the
    // calendar/instant split exists to prevent.
    expect(decodeValue(DATE, '2026-08-09')).toBe('2026-08-09');
  });
});

describe('unit · bytea', () => {
  test('the hex form becomes the Uint8Array bytes() parses to', () => {
    const value = decodeValue(BYTEA, '\\x0102ff');
    expect(value).toBeInstanceOf(Uint8Array);
    expect([...(value as Uint8Array)]).toEqual([1, 2, 255]);
  });

  test('an empty bytea is an empty array, never the two-character text', () => {
    expect([...(decodeValue(BYTEA, '\\x') as Uint8Array)]).toEqual([]);
  });

  test('anything but the hex form keeps its text', () => {
    expect(decodeValue(BYTEA, 'abc')).toBe('abc');
    expect(decodeValue(BYTEA, '\\x0g')).toBe('\\x0g');
    expect(decodeValue(BYTEA, '\\x012')).toBe('\\x012');
  });
});

describe('unit · arrays', () => {
  test('a text array becomes a JS array, not the literal', () => {
    expect(decodeValue(TEXT_ARRAY, '{a,b}')).toEqual(['a', 'b']);
    expect(decodeValue(TEXT_ARRAY, '{}')).toEqual([]);
  });

  test('every element is decoded by its own type', () => {
    expect(decodeValue(INT4_ARRAY, '{1,2,3}')).toEqual([1, 2, 3]);
    const instants = decodeValue(TIMESTAMPTZ_ARRAY, '{"2026-08-09 12:00:00+00"}');
    expect(instants).toEqual([new Date('2026-08-09T12:00:00.000Z')]);
  });

  test('quoting carries the members a bare split would lose', () => {
    expect(decodeValue(TEXT_ARRAY, '{"a,b","c\\"d","e\\\\f"}')).toEqual(['a,b', 'c"d', 'e\\f']);
  });

  test('an unquoted NULL is the null member and a quoted one is the string', () => {
    expect(decodeValue(TEXT_ARRAY, '{NULL,"NULL"}')).toEqual([null, 'NULL']);
  });

  test('a literal this grammar does not describe keeps its text', () => {
    // A dimension prefix and an unterminated literal both mean the same thing: an array missing a
    // member is worse than the text, which still crosses.
    expect(decodeValue(TEXT_ARRAY, '[0:1]={a,b}')).toBe('[0:1]={a,b}');
    expect(decodeValue(TEXT_ARRAY, '{a,b')).toBe('{a,b');
    expect(decodeValue(TEXT_ARRAY, '{a,b}}')).toBe('{a,b}}');
  });

  test('a multidimensional literal keeps its nesting', () => {
    expect(parsePgArray('{{1,2},{3}}', (raw) => Number(raw))).toEqual([[1, 2], [3]]);
  });

  test('an oid with no element in the table is left alone', () => {
    // A user-defined enum's array oid is per-database, so it cannot be tabulated — and guessing
    // an element type is how a value is silently mis-decoded.
    expect(arrayElementOid(999_999)).toBeUndefined();
    expect(decodeValue(999_999, '{a,b}')).toBe('{a,b}');
  });
});
