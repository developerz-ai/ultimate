// What each wide column accepts, what it refuses, and the Postgres type it becomes. Every rule
// here is one an existing schema depends on: a `numeric(18,8)` that silently rounded, a `bigint`
// that lost its last digits, a `date` that acquired a time, or a `json` that validated nothing
// would each be a wrong value nobody could see until the table was read back somewhere else.

import { afterAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { PlainDate } from '@ultimat3/time';
import { money, text, timestamp, uuid } from './columns';
import { arrayOf, bigint, bytes, date, decimal, json } from './columns-data';
import { sqlTypeOf } from './describe';
import { entity } from './entity';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const caught = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

/** The `fix:` line a refusal emits — the half of an error `message` does not carry. */
const fixOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof UltimateError ? error.fix : undefined;
  }
  return undefined;
};

describe('unit · json()', () => {
  const settings = json(t.object({ plan: t.string, seats: t.number }));

  test('validates the contents through the schema it was given', () => {
    expect(settings.$parse({ plan: 'team', seats: 4 })).toEqual({ plan: 'team', seats: 4 });
    expect(caught(() => settings.$parse({ plan: 'team' }))).toContain('seats');
    expect(caught(() => settings.$parse({ plan: 'team', seats: 'four' }))).toContain('seats');
    expect(caught(() => settings.$parse('nope'))).toContain('schema');
  });

  test('the rejection names the PATH, never the value — a column message reaches the log', () => {
    const message = caught(() => settings.$parse({ plan: 'secret-token-value', seats: 'x' })) ?? '';
    expect(message).toContain('seats');
    expect(message).not.toContain('secret-token-value');
  });

  test('it is jsonb, and its own kind carries no schema into the DDL', () => {
    expect(settings.$meta.kind).toBe('jsonb');
    expect(sqlTypeOf(settings.$meta)).toBe('jsonb');
  });
});

describe('unit · bigint()', () => {
  const external = bigint();

  test('a value past 2^53 survives, which is the entire reason the row type is a string', () => {
    expect(external.$parse('9007199254740993')).toBe('9007199254740993');
    expect(external.$parse(-1)).toBe('-1');
    // Both driver spellings arrive here: Bun's `sql` hands over a string, PGlite a bigint.
    expect(external.$parse(9007199254740993n)).toBe('9007199254740993');
    expect(JSON.stringify({ id: external.$parse(9007199254740993n) })).toBe(
      '{"id":"9007199254740993"}',
    );
  });

  test('a number that has already lost digits is refused rather than stored', () => {
    // `2 ** 53` rather than the literal: a literal that loses precision is itself a lint error,
    // which is the same fact this line asserts one layer down.
    expect(caught(() => external.$parse(2 ** 53))).toContain('2^53');
    expect(caught(() => external.$parse(1.5))).toContain('2^53');
    expect(caught(() => external.$parse('12.0'))).toContain('whole digits');
    expect(caught(() => external.$parse('one'))).toContain('whole digits');
  });
});

describe('unit · decimal()', () => {
  const rate = decimal({ precision: 18, scale: 8 });

  test('the exact digits round-trip as a string — no float ever touches the value', () => {
    expect(rate.$parse('1.23456789')).toBe('1.23456789');
    expect(rate.$parse('-0.00000001')).toBe('-0.00000001');
    expect(rate.$parse(1.5)).toBe('1.5');
  });

  test('a value the column would ROUND is refused where the caller still knows what it meant', () => {
    expect(caught(() => rate.$parse('1.234567891'))).toContain('decimal places');
    expect(caught(() => rate.$parse('12345678901.1'))).toContain('numeric(18, 8)');
    expect(caught(() => rate.$parse('nope'))).toContain('decimal');
    expect(caught(() => rate.$parse(Number.NaN))).toContain('decimal');
  });

  test('precision and scale are declared together, and emit the type Postgres wants', () => {
    expect(sqlTypeOf(rate.$meta)).toBe('numeric(18, 8)');
    expect(sqlTypeOf(decimal().$meta)).toBe('numeric');
    expect(caught(() => decimal({ precision: 10 }))).toContain('together');
    expect(caught(() => decimal({ precision: 4, scale: 9 }))).toContain('scale');
  });
});

describe('unit · date()', () => {
  const day = date();

  test('a calendar date, and nothing that carries a time or a zone with it', () => {
    expect(day.$parse('2026-03-14')).toBe('2026-03-14' as PlainDate);
    expect(caught(() => day.$parse('2026-02-30'))).toContain('calendar date');
    expect(caught(() => day.$parse('2026-03-14T00:00:00Z'))).toContain('calendar date');
    expect(caught(() => day.$parse(1_772_000_000_000))).toContain('calendar date');
  });

  test('the Date a driver returns for a date column reads as the date it holds', () => {
    // Postgres hands back midnight UTC. The value carries no time afterwards, by construction.
    expect(day.$parse(new Date('2026-03-14T00:00:00.000Z'))).toBe('2026-03-14' as PlainDate);
    expect(String(day.$parse(new Date('2026-03-14T00:00:00.000Z')))).not.toContain('T');
    expect(caught(() => day.$parse(new Date('nope')))).toContain('calendar date');
  });

  test('it is `date`, never `timestamptz` — the distinction the whole type exists for', () => {
    expect(day.$meta.kind).toBe('date');
    expect(sqlTypeOf(day.$meta)).toBe('date');
    expect(timestamp().$meta.kind).toBe('timestamptz');
  });
});

describe('unit · bytes() and arrayOf()', () => {
  test('bytes normalises both drivers into one plain Uint8Array', () => {
    const blob = bytes();
    const buffer = Buffer.from([1, 2, 3]);
    const parsed = blob.$parse(buffer);
    expect([...parsed]).toEqual([1, 2, 3]);
    // A `Buffer` and a `Uint8Array` do not serialise alike, so the row holds the plain one.
    expect(Object.getPrototypeOf(parsed)).toBe(Uint8Array.prototype);
    expect(caught(() => blob.$parse('AQID'))).toContain('bytes');
    expect(sqlTypeOf(blob.$meta)).toBe('bytea');
  });

  test('an array is its element column, applied per member', () => {
    const tags = arrayOf(text({ max: 4 }));
    expect(tags.$parse(['ab', 'cd'])).toEqual(['ab', 'cd']);
    expect(caught(() => tags.$parse('ab'))).toContain('array');
    expect(caught(() => tags.$parse([1]))).toContain('string');
    expect(sqlTypeOf(tags.$meta)).toBe('text[]');
    expect(sqlTypeOf(arrayOf(uuid()).$meta)).toBe('uuid[]');
    expect(sqlTypeOf(arrayOf(decimal({ precision: 6, scale: 2 })).$meta)).toBe('numeric(6, 2)[]');
  });

  test('an element with no single column behind it is refused at declaration', () => {
    expect(caught(() => arrayOf(arrayOf(text())))).toContain('one scalar column');
    expect(caught(() => arrayOf(money()))).toContain('one scalar column');
  });

  // The loss this refusal exists for was production-only: `bindValues` rendered every object
  // element as `""` — measured, two objects bound as `{"",""}` and one blob as `{""}` — while
  // `memoryRepo` kept the value, so every test in the tree passed and only the table was wrong.
  test('a jsonb or bytea element is refused at declaration, where the object is still visible', () => {
    expect(caught(() => arrayOf(json(t.object({ a: t.string }))))).toContain('empty string');
    expect(caught(() => arrayOf(bytes()))).toContain('empty string');
  });

  // Whole strings, not substrings: a `toContain('json(t.array(')` passed while the rest of the
  // line read `json(t.array(<element schema>))`, and a reader who pastes `<element schema>` gets a
  // syntax error. What the fix must be is a MECHANICAL edit with nothing left to supply.
  test('each refusal is one complete edit, with no placeholder to fill in', () => {
    expect(fixOf(() => arrayOf(json(t.object({ a: t.string }))))).toBe(
      'rewrite arrayOf(json(S)) as json(t.array(S)) with S unchanged — one jsonb column holds the ' +
        'whole list and t.array still validates every member',
    );
    expect(fixOf(() => arrayOf(bytes()))).toBe(
      'move the list to its own entity and relate it — ' +
        "entity('blobs', { columns: { data: bytes() } }) — then drop this column: one row per blob, " +
        'and bytea has no array literal that survives the driver',
    );
    expect(fixOf(() => arrayOf(money()))).toBe(
      'move the list to its own entity and relate it — ' +
        "entity('amounts', { columns: { amount: money() } }) — then drop this column: an array " +
        'column is ONE column and money() is three (minor, currency, scale)',
    );
    expect(fixOf(() => arrayOf(arrayOf(text())))).toBe(
      'rewrite arrayOf(arrayOf(x)) as arrayOf(x) if the nesting carries no meaning, or move the ' +
        "inner list to its own entity and relate it — entity('items', { columns: { value: text() } })",
    );
  });

  // Never `x entities describe column --json`, which `reject()` emits: there is no entity to
  // describe at declaration time, so that command is `X_DECLARATION_UNKNOWN` — a fix line that
  // reproduces an error rather than repairing one. And nothing may reach the reader unfinished:
  // an angle-bracket slot is the placeholder form this refusal shipped with.
  test('no refusal cites a command that cannot run, and none carries a placeholder', () => {
    const fixes = [
      fixOf(() => arrayOf(json(t.object({ a: t.string })))),
      fixOf(() => arrayOf(bytes())),
      fixOf(() => arrayOf(money())),
      fixOf(() => arrayOf(arrayOf(text()))),
    ];
    for (const fix of fixes) {
      expect(fix).not.toContain('x entities describe column');
      expect(fix).not.toMatch(/<[a-z][a-z ]*>/);
    }
  });
});

describe('unit · the wide columns inside an entity', () => {
  const readings = entity('wide_test_readings', {
    columns: {
      id: uuid().primaryKey(),
      rate: decimal({ precision: 12, scale: 4 }),
      takenOn: date(),
      payload: json(t.object({ ok: t.boolean })),
      labels: arrayOf(text({ max: 8 })),
    },
  });

  test('the DDL projection carries the precise type of every one of them', () => {
    const columns = new Map(readings.$describe().columns.map((one) => [one.column, one.kind]));
    expect(columns.get('rate')).toBe('numeric(12, 4)');
    expect(columns.get('taken_on')).toBe('date');
    expect(columns.get('payload')).toBe('jsonb');
    expect(columns.get('labels')).toBe('text[]');
  });

  test('a row goes through the columns that declared it, wide ones included', () => {
    const row = readings.$parse({
      id: '00000000-0000-7000-8000-0000000000c1',
      rate: '1.5',
      takenOn: '2026-03-14',
      payload: { ok: true },
      labels: ['a'],
    });
    expect(row.rate).toBe('1.5');
    expect(row.takenOn).toBe('2026-03-14' as PlainDate);
    expect(caught(() => readings.$parse({ ...row, takenOn: '2026-02-30' }))).toContain(
      'calendar date',
    );
  });
});
