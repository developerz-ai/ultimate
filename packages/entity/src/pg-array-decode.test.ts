// An `arrayOf()` cell in each shape a driver hands it back, and `decodeRow` over them. The shapes
// are measured, not imagined: `Bun.SQL` 1.4.2 answers `uuid[]` with its literal and — on a pool
// that prepares statements — `int4[]` with an `Int32Array`; PGlite answers both with an `Array`.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { plainDate } from '@ultimat3/time';
import { boolean, integer, text, timestamp, uuid } from './columns';
import { arrayOf, bigint, date, decimal } from './columns-data';
import { entity } from './entity';
import { arrayFromDriver, NOT_AN_ARRAY } from './pg-array-decode';
import { decodeRow } from './pg-row';
import { clearRegistry } from './registry';

const A = '01a12719-28e5-735e-b5bb-000000000001';
const B = '01a12719-28e5-735e-b5bb-000000000002';

const rows = entity('array_decode_rows', {
  columns: {
    id: uuid().primaryKey(),
    label: text(),
    refs: arrayOf(uuid()).nullable(),
    gaps: arrayOf(uuid().nullable()).nullable(),
    tags: arrayOf(text()).nullable(),
    counts: arrayOf(integer().nullable()).nullable(),
    flags: arrayOf(boolean().nullable()).nullable(),
    ats: arrayOf(timestamp()).nullable(),
    rates: arrayOf(decimal()).nullable(),
    days: arrayOf(date()).nullable(),
    bigs: arrayOf(bigint()).nullable(),
  },
});

afterAll(() => {
  clearRegistry();
});

const decode = (cells: Readonly<Record<string, unknown>>) =>
  decodeRow(rows, { id: A, label: 'x', ...cells });

/** The refusal's code and cause, or the value that came back when nothing was refused. */
const refusal = (work: () => unknown): { code: string; cause: string } | { value: unknown } => {
  try {
    return { value: work() };
  } catch (error) {
    if (!isUltimateError(error)) throw error;
    return { code: error.code, cause: String(error.cause) };
  }
};

describe('decodeRow · what is NOT an array is refused, by the column that declared one', () => {
  test.each([
    ['a bare uuid', A],
    ['a comma-joined list', `${A},${B}`],
    ['an unclosed literal', `{${A}`],
    ['a JSON array as text', `["${A}"]`],
    ['an empty string', ''],
  ])('%s is X_INVARIANT_VIOLATED and names the column', (_name, cell) => {
    const outcome = refusal(() => decode({ refs: cell }));
    expect(outcome).toMatchObject({ code: 'X_INVARIANT_VIOLATED' });
    expect(JSON.stringify(outcome)).toContain('array_decode_rows.refs');
    expect(JSON.stringify(outcome)).toContain('not a Postgres array literal');
  });

  test('a number, an object and a boolean are refused the same way', () => {
    for (const cell of [7, { 0: A }, true]) {
      expect(refusal(() => decode({ refs: cell }))).toMatchObject({ code: 'X_INVARIANT_VIOLATED' });
    }
  });

  test('a well-formed literal of the wrong element is refused by the ELEMENT column', () => {
    expect(refusal(() => decode({ refs: '{not-a-uuid}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
    expect(refusal(() => decode({ counts: '{1,abc}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
    expect(refusal(() => decode({ counts: '{1.5}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
    expect(refusal(() => decode({ flags: '{yes}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
    expect(refusal(() => decode({ ats: '{"not an instant"}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
  });

  test('a second dimension is refused: arrayOf() declares one', () => {
    expect(refusal(() => decode({ tags: '{{a,b},{c,d}}' }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
  });

  test('a null member is refused where the element is not nullable', () => {
    expect(refusal(() => decode({ refs: `{${A},NULL}` }))).toMatchObject({
      code: 'X_INVARIANT_VIOLATED',
    });
  });

  test('a text column holding a literal-shaped string keeps the string', () => {
    expect(decode({ label: '{a,b}' }).label).toBe('{a,b}');
  });
});

describe('decodeRow · the literal a driver left unparsed', () => {
  test('uuid[] — the shape Bun.SQL hands back', () => {
    expect(decode({ refs: `{${A},${B}}` }).refs).toEqual([A, B]);
    expect(decode({ refs: '{}' }).refs).toEqual([]);
    expect(decode({ gaps: `{${A},NULL}` }).gaps).toEqual([A, null]);
    expect(decode({ refs: null }).refs).toBeNull();
  });

  test('a uuid is still a value: upper case reads back lower-cased', () => {
    expect(decode({ refs: `{${A.toUpperCase()}}` }).refs).toEqual([A]);
  });

  test('text[] with every character the literal quotes', () => {
    expect(decode({ tags: '{plain,"a,b","q\\"x","b\\\\y","{c}",""," d ","NULL"}' }).tags).toEqual([
      'plain',
      'a,b',
      'q"x',
      'b\\y',
      '{c}',
      '',
      ' d ',
      'NULL',
    ]);
  });

  test('int4[] is numbers, bool[] is booleans, with the null member kept', () => {
    expect(decode({ counts: '{1,NULL,-2147483648}' }).counts).toEqual([1, null, -2147483648]);
    expect(decode({ flags: '{t,f,NULL}' }).flags).toEqual([true, false, null]);
  });

  test('timestamptz[] is Dates at the instant the offset names', () => {
    const { ats } = decode({
      ats: '{"2026-01-02 03:04:05.123456+00","2026-01-02 03:04:05-05","1969-12-31 23:59:59.9995+00"}',
    });
    expect(ats?.map((at) => at.toISOString())).toEqual([
      '2026-01-02T03:04:05.123Z',
      '2026-01-02T08:04:05.000Z',
      '1969-12-31T23:59:59.999Z',
    ]);
  });

  test('numeric[], int8[] and date[] keep the text Postgres wrote', () => {
    expect(decode({ rates: '{1.50,-0.5}' }).rates).toEqual(['1.50', '-0.5']);
    expect(decode({ bigs: '{9007199254740993,-1}' }).bigs).toEqual(['9007199254740993', '-1']);
    expect(decode({ days: '{2026-03-14,1970-01-01}' }).days).toEqual([
      plainDate('2026-03-14'),
      plainDate('1970-01-01'),
    ]);
  });
});

describe('decodeRow · the other two shapes', () => {
  test('a JS array is parsed member by member, as it always was', () => {
    expect(decode({ refs: [A, B] }).refs).toEqual([A, B]);
    expect(decode({ counts: [1, null] }).counts).toEqual([1, null]);
  });

  test('a typed array — Bun.SQL on a preparing pool — is a plain array of its numbers', () => {
    const { counts } = decode({ counts: new Int32Array([1, 2, 3]) });
    expect(counts).toEqual([1, 2, 3]);
    expect(Array.isArray(counts)).toBe(true);
    expect(decode({ counts: new Int32Array([]) }).counts).toEqual([]);
  });
});

describe('arrayFromDriver', () => {
  const meta = rows.$columns.refs.$meta;

  test('answers NOT_AN_ARRAY rather than guessing', () => {
    for (const cell of ['a,b', '', 7, {}, new DataView(new ArrayBuffer(4)), undefined, null]) {
      expect(arrayFromDriver(meta, cell)).toBe(NOT_AN_ARRAY);
    }
  });

  test('hands a JS array back untouched, so no member is copied on the common path', () => {
    const cell = [A];
    expect(arrayFromDriver(meta, cell)).toBe(cell);
  });
});
