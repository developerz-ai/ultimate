// Single responsibility: compute an aggregate from ROWS ALREADY IN HAND — the in-memory driver's
// half of `aggregate.ts`, split out because that file is the shared RULES (which kinds, which
// refusals, the decimal arithmetic) and this one is one driver's execution of them.
//
// Every path here is exact. A `sum` goes through `sumDecimalText`, not `+`: the rows of a
// `bigint()` or `decimal()` column are decimal STRINGS, and `Number()` on one loses digits past
// 2^53 and cents below it — which is the whole reason those columns hand back text.

import type { AggregateFn, MoneyUnit } from './aggregate';
import { aggregateMinor, assertOneUnit, averageDecimalText, sumDecimalText } from './aggregate';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import { compareByKind } from './memory-match';
import type { ColumnKind, MoneyValue } from './types';

/** A row's value for this aggregate, or `undefined` for the absences SQL does not count. */
const present = (value: unknown): boolean => value !== null && value !== undefined;

const moneyOf = (value: unknown): MoneyValue | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Partial<MoneyValue>;
  return typeof record.minor === 'number' && typeof record.currency === 'string'
    ? (record as MoneyValue)
    : undefined;
};

/** The text form a decimal aggregate adds. `integer` rows are numbers; every other kind is text. */
const decimalText = (value: unknown): string =>
  typeof value === 'bigint' ? value.toString() : String(value);

/**
 * `min`/`max` by the column's DECLARED kind, never by the JS type in hand — the rule this package
 * decides every comparison with. `compareByKind` is the same function the sort and the keyset seek
 * read, so a minimum here is the row a `.orderBy(col, 'asc').one()` would have answered with.
 */
const extreme = (kind: ColumnKind, values: readonly unknown[], fn: 'min' | 'max'): unknown =>
  values.reduce((best, value) => {
    const order = compareByKind(kind, value, best);
    return (fn === 'min' ? order < 0 : order > 0) ? value : best;
  });

/**
 * The aggregate, over exactly the rows the caller's predicate matched. `null` for an empty set in
 * every function, because that is what SQL answers — never `0`, which would claim rows were seen.
 */
export const foldAggregate = <Row>(
  entity: EntityCore<Row>,
  fn: AggregateFn,
  property: string,
  kind: ColumnKind,
  rows: readonly Row[],
): unknown => {
  const values = rows.map((row) => valueAt(row, property)).filter(present);
  if (values.length === 0) return null;
  if (kind === 'money') {
    const amounts = values.flatMap((value) => {
      const money = moneyOf(value);
      return money === undefined ? [] : [money];
    });
    if (amounts.length === 0) return null;
    const unit = assertOneUnit(
      entity,
      fn,
      property,
      amounts.map((money): MoneyUnit => ({ currency: money.currency, scale: money.scale ?? null })),
    );
    if (unit === undefined) return null;
    const minor =
      fn === 'sum'
        ? aggregateMinor(
            entity,
            fn,
            property,
            sumDecimalText(amounts.map((money) => String(money.minor))) ?? '0',
          )
        : (extreme(
            'integer',
            amounts.map((money) => money.minor),
            fn === 'min' ? 'min' : 'max',
          ) as number);
    return {
      minor,
      currency: unit.currency,
      ...(unit.scale === null ? {} : { scale: unit.scale }),
    } satisfies MoneyValue;
  }
  if (fn === 'sum') return sumDecimalText(values.map(decimalText));
  if (fn === 'avg')
    return averageDecimalText(sumDecimalText(values.map(decimalText)), values.length);
  return extreme(kind, values, fn);
};
