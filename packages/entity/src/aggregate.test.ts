// The rules both drivers read: the exact decimal arithmetic, which kinds each function may be
// applied to, and every refusal. Nothing here needs a driver — that is the point of the split, and
// `pg-aggregate.live.test.ts` proves the same answers against a real server and against memory
// side by side.

import { afterAll, describe, expect, test } from 'bun:test';
import {
  AVG_SCALE,
  aggregatable,
  aggregateColumnOf,
  aggregateMinor,
  assertOneUnit,
  averageDecimalText,
  sumDecimalText,
} from './aggregate';
import { boolean, integer, money, text, timestamp, uuid } from './columns';
import { decimal } from './columns-data';
import { entity } from './entity';
import { clearRegistry } from './registry';

const ledger = entity('aggregate_test_ledger', {
  columns: {
    id: uuid().primaryKey(),
    label: text({ max: 40 }),
    likeCount: integer().default(0),
    rate: decimal({ precision: 12, scale: 4 }),
    amount: money(),
    settled: boolean().default(false),
    at: timestamp().defaultNow(),
  },
});

afterAll(() => {
  clearRegistry();
});

const caught = (run: () => unknown): unknown => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('sumDecimalText', () => {
  test('is exact where a float is not', () => {
    // `0.1 + 0.2` is `0.30000000000000004` in a binary float. A `decimal()` column exists so that
    // never reaches a row, and an aggregate over one must not reintroduce it.
    expect(sumDecimalText(['0.1', '0.2'])).toBe('0.3');
  });

  test('keeps every digit past 2^53, which is where an int8 key lives', () => {
    expect(sumDecimalText(['9007199254740993', '9007199254740993'])).toBe('18014398509481986');
  });

  test('answers at the widest scale any term carried', () => {
    expect(sumDecimalText(['1', '0.250', '2.5'])).toBe('3.750');
  });

  test('negatives cross zero exactly', () => {
    expect(sumDecimalText(['-1.05', '1.05'])).toBe('0.00');
    expect(sumDecimalText(['-10.5', '1.25'])).toBe('-9.25');
  });

  test('an empty set is null, never zero — SQL answers the same', () => {
    expect(sumDecimalText([])).toBeNull();
  });
});

describe('averageDecimalText', () => {
  test('rounds half away from zero at a FIXED scale, so two drivers land on one number', () => {
    expect(AVG_SCALE).toBe(6);
    // 4/3 = 1.333333…; 5/3 = 1.666666…7
    expect(averageDecimalText('4', 3)).toBe('1.333333');
    expect(averageDecimalText('5', 3)).toBe('1.666667');
  });

  test('a negative mean rounds away from zero too, exactly as Postgres round() does', () => {
    expect(averageDecimalText('-5', 3)).toBe('-1.666667');
  });

  test('an exact mean carries the scale rather than dropping it', () => {
    expect(averageDecimalText('10', 4)).toBe('2.500000');
  });

  test('no rows is null, and never a division by zero', () => {
    expect(averageDecimalText(null, 0)).toBeNull();
    expect(averageDecimalText('4', 0)).toBeNull();
  });
});

describe('which kinds each function takes', () => {
  test('text has no min or max, because the two drivers cannot agree on one', () => {
    // Postgres orders `text` by the database COLLATION and this package orders it by JS UTF-16
    // code units. `'a' < 'B'` under en_US and `'B' < 'a'` by code unit — a comparison that cannot
    // be made to agree is refused rather than answered two different ways.
    expect(aggregatable('min', 'text')).toBe(false);
    expect(aggregatable('max', 'char')).toBe(false);
    const error = caught(() => aggregateColumnOf(ledger, 'min', 'label'));
    expect(error).toBeUltimateError('X_AGGREGATE_UNSUPPORTED');
    // The fix names a column of THIS entity that would work — the entity is the only place it lives.
    expect(error instanceof Error ? (error as { fix?: string }).fix : '').toContain('likeCount');
  });

  test('boolean has no aggregate at all', () => {
    expect(caught(() => aggregateColumnOf(ledger, 'sum', 'settled'))).toBeUltimateError(
      'X_AGGREGATE_UNSUPPORTED',
    );
  });

  test('a timestamp has min and max but no sum', () => {
    expect(caught(() => aggregateColumnOf(ledger, 'min', 'at'))).toBeUndefined();
    expect(caught(() => aggregateColumnOf(ledger, 'sum', 'at'))).toBeUltimateError(
      'X_AGGREGATE_UNSUPPORTED',
    );
  });

  test('avg over money is refused, because every answer would be a silent rounding', () => {
    // The mean of 1, 1 and 2 minor units is 4/3 of one. `MoneyValue.scale` exists precisely so a
    // sub-unit amount is not rounded away, so inventing a rounding at the aggregate would reopen
    // the defect one layer up. The fix hands the decision back to the call site.
    const error = caught(() => aggregateColumnOf(ledger, 'avg', 'amount'));
    expect(error).toBeUltimateError('X_AGGREGATE_UNSUPPORTED');
    const fix = error instanceof Error ? (error as { fix?: string }).fix : '';
    expect(fix).toContain("sum('amount')");
    expect(fix).toContain('count()');
    // And sum/min/max over the same column are fine — only the mean has no exact answer.
    expect(caught(() => aggregateColumnOf(ledger, 'sum', 'amount'))).toBeUndefined();
    expect(caught(() => aggregateColumnOf(ledger, 'max', 'amount'))).toBeUndefined();
  });

  test('a column the entity never declared is refused with the list that would work', () => {
    expect(caught(() => aggregateColumnOf(ledger, 'sum', 'nope'))).toBeUltimateError(
      'X_AGGREGATE_UNSUPPORTED',
    );
  });
});

describe('one amount is one unit', () => {
  test('two currencies have no common unit', () => {
    const error = caught(() =>
      assertOneUnit(ledger, 'sum', 'amount', [
        { currency: 'USD', scale: null },
        { currency: 'EUR', scale: null },
      ]),
    );
    expect(error).toBeUltimateError('X_AGGREGATE_MIXED_CURRENCY');
    expect(error instanceof Error ? error.message : '').toContain('EUR, USD');
  });

  test('two SCALES of one currency have no common unit either', () => {
    // The half with no symptom: `{ minor: 5, currency: 'USD' }` is five cents and the same row at
    // `scale: 6` is five millionths of a dollar. Adding them is a 10,000x error and no currency
    // check would have seen it.
    expect(
      caught(() =>
        assertOneUnit(ledger, 'sum', 'amount', [
          { currency: 'USD', scale: null },
          { currency: 'USD', scale: 6 },
        ]),
      ),
    ).toBeUltimateError('X_AGGREGATE_MIXED_CURRENCY');
  });

  test('one unit, however many rows carried it', () => {
    expect(
      assertOneUnit(ledger, 'sum', 'amount', [
        { currency: 'USD', scale: 2 },
        { currency: 'USD', scale: 2 },
      ]),
    ).toEqual({ currency: 'USD', scale: 2 });
  });
});

describe('the minor unit an aggregate answers with', () => {
  test('is refused past ±2^53, never rounded', () => {
    // The column is `bigint` and `MoneyValue.minor` is a `number`. One row past the bound is
    // already `X_INVARIANT_VIOLATED` at `parseMinor`; a SUM reaches it far more easily, and a
    // rounded total is a wrong number with no symptom at all.
    expect(aggregateMinor(ledger, 'sum', 'amount', '9007199254740991')).toBe(9007199254740991);
    expect(
      caught(() => aggregateMinor(ledger, 'sum', 'amount', '9007199254740992')),
    ).toBeUltimateError('X_AGGREGATE_UNSUPPORTED');
    expect(
      caught(() => aggregateMinor(ledger, 'sum', 'amount', '-9007199254740992')),
    ).toBeUltimateError('X_AGGREGATE_UNSUPPORTED');
  });
});
