// Single responsibility: what an aggregate MEANS — which column kinds each function may be applied
// to, what its answer is shaped like, and the exact arithmetic. Both drivers read it from here, so
// a `sum` against memory means what a `sum` against Postgres means; a rule added to one driver
// alone is the drift the two-driver split exists to prevent.
//
// Nothing here is a float. `sum` and `avg` answer decimal TEXT, money answers `MoneyValue` — the
// same reason `bigint()` and `decimal()` hand back strings: a `number` loses digits past 2^53 and
// a binary float loses cents.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import type { AnyColumn, ColumnKind } from './types';

/** The four, closed. A fifth is a new member here and a new case in both drivers, never one. */
export type AggregateFn = 'sum' | 'avg' | 'min' | 'max';

/**
 * Which kinds each function may be applied to. Closed sets rather than "whatever Postgres accepts",
 * because the bar is what BOTH drivers can answer identically.
 *
 * `text` and `char` are deliberately absent from `min`/`max` even though Postgres has them: text
 * ordering there is the database's COLLATION and here it is JS's UTF-16 code-unit order, and the
 * two disagree on ordinary data (`'a' < 'B'` under `en_US`, `'B' < 'a'` by code unit). A comparison
 * this package cannot make agree is refused rather than answered twice differently — the same
 * decision `memory-match.ts` records for decimal text, in the other direction.
 *
 * `boolean`, `uuid`, `jsonb`, `array` and `bytea` are absent everywhere: none of them has an
 * ordering or a sum a caller would mean.
 */
const NUMERIC: readonly ColumnKind[] = ['integer', 'bigint', 'numeric'];
const ORDERED: readonly ColumnKind[] = ['integer', 'bigint', 'numeric', 'timestamptz', 'date'];

const ALLOWED = new Map<AggregateFn, ReadonlySet<ColumnKind>>([
  ['sum', new Set<ColumnKind>([...NUMERIC, 'money'])],
  ['avg', new Set<ColumnKind>(NUMERIC)],
  ['min', new Set<ColumnKind>([...ORDERED, 'money'])],
  ['max', new Set<ColumnKind>([...ORDERED, 'money'])],
]);

export const aggregatable = (fn: AggregateFn, kind: ColumnKind): boolean =>
  ALLOWED.get(fn)?.has(kind) === true;

/**
 * `avg` over money is refused rather than rounded. The average of 1, 1 and 2 minor units is 4/3 of
 * a unit, and every representable answer is a rounding — which is the defect `MoneyValue.scale`
 * exists to prevent, so inventing one at the aggregate would reopen it one layer up. The caller
 * decides the rounding, out of two exact numbers.
 */
export const notAggregatable = (
  entityName: string,
  fn: AggregateFn,
  property: string,
  kind: ColumnKind,
  candidates: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_AGGREGATE_UNSUPPORTED',
    cause:
      fn === 'avg' && kind === 'money'
        ? `${entityName}.avg('${property}') — the mean of an integer number of minor units is not one, and every answer would be a silent rounding`
        : `${entityName}.${fn}('${property}') — a ${kind} column has no ${fn} both drivers can answer the same way`,
    fix:
      fn === 'avg' && kind === 'money'
        ? `${entityName}.sum('${property}') and ${entityName}.count() — divide at the call site, where the rounding is a decision somebody made`
        : candidates.length === 0
          ? `x entities describe ${entityName} --json   # this entity declares no column ${fn} can be applied to`
          : `${entityName}.${fn}('${candidates[0]}')   # ${fn} takes one of: ${candidates.join(', ')}`,
  });

/**
 * Money crossing currencies has no sum, no minimum and no maximum: 100 JPY and 100 EUR are not
 * comparable and adding them answers a number in no currency at all. Both drivers count the
 * distinct currencies of the rows they are about to aggregate and refuse past one, rather than
 * silently answering in whichever currency happened to come first.
 */
export const mixedCurrency = (
  entityName: string,
  fn: AggregateFn,
  property: string,
  currencies: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_AGGREGATE_MIXED_CURRENCY',
    cause: `${entityName}.${fn}('${property}') covers ${currencies.length} currencies (${[...currencies].sort().join(', ')}) — they have no common unit`,
    fix: `${entityName}.andWhere('${property}.currency', 'eq', '${[...currencies].sort()[0]}').${fn}('${property}')   # one currency per call, or countBy('${property}.currency') first`,
  });

/** Digits only, optionally signed, optionally with a fraction. What `decimal()` hands back. */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;

/** The scale `avg` answers at, in both drivers. Fixed, so the two cannot round to different places. */
export const AVG_SCALE = 6;

interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

const parseDecimal = (text: string): Decimal | undefined => {
  if (!DECIMAL_TEXT.test(text)) return undefined;
  const [whole = '0', fraction = ''] = text.split('.');
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
};

const rescale = (value: Decimal, scale: number): bigint =>
  value.units * 10n ** BigInt(scale - value.scale);

const render = (units: bigint, scale: number): string => {
  if (scale === 0) return units.toString();
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${digits.slice(digits.length - scale)}`;
};

/**
 * The exact sum of decimal text, at the widest scale any term carries — which is what Postgres'
 * `sum(numeric)` answers, and what no `Number()` can: `0.1 + 0.2` is `0.30000000000000004` in a
 * binary float and `0.3` here, and an `int8` past 2^53 keeps every digit.
 *
 * `null` for an empty set, exactly as `sum` over no rows is NULL in SQL — never `0`, which would
 * claim rows were counted.
 */
export const sumDecimalText = (values: readonly string[]): string | null => {
  if (values.length === 0) return null;
  const parsed = values.map(parseDecimal);
  if (parsed.some((value) => value === undefined)) return null;
  const decimals = parsed as readonly Decimal[];
  const scale = decimals.reduce((widest, value) => Math.max(widest, value.scale), 0);
  return render(
    decimals.reduce((total, value) => total + rescale(value, scale), 0n),
    scale,
  );
};

/**
 * `sum / count`, rounded half away from zero at `AVG_SCALE` — which is what Postgres' `round()`
 * does to a `numeric`, and the reason the statement asks for `round(avg(...), 6)` rather than the
 * server's own default scale: two drivers rounding at different places answer two numbers.
 */
export const averageDecimalText = (total: string | null, count: number): string | null => {
  if (total === null || count === 0) return null;
  const parsed = parseDecimal(total);
  if (parsed === undefined) return null;
  // The EXACT rational, rounded once. Dividing first and rounding after would truncate digits the
  // rounding decision depends on — and rescaling to a fixed number of digits rather than to
  // AVG_SCALE is what made this answer 11000.000000 where Postgres said 1.100000: `rescale` takes
  // an absolute target scale, and the first draft handed it a relative one.
  const digits = Math.max(parsed.scale, AVG_SCALE);
  const numerator = rescale(parsed, digits);
  const denominator = BigInt(count) * 10n ** BigInt(digits - AVG_SCALE);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  // `(2m + d) / 2d` is `floor(m/d + 1/2)` in integers — half AWAY FROM ZERO once the sign is put
  // back, which is what Postgres' `round(numeric)` does. No float, no intermediate truncation.
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return render(negative ? -rounded : rounded, AVG_SCALE);
};

/**
 * The column an aggregate runs over, resolved and judged before either driver builds anything —
 * so `sum('title')` is refused with the same words and the same code whichever driver is attached.
 */
export const aggregateColumnOf = <Row>(
  entity: EntityCore<Row>,
  fn: AggregateFn,
  property: string,
): AnyColumn => {
  const candidates = Object.entries(entity.$columns)
    .filter(([, each]) => aggregatable(fn, each.$meta.kind))
    .map(([name]) => name);
  const column = columnFor(entity.$columns, property);
  if (column === undefined) {
    throw notAggregatable(entity.$name, fn, property, 'text', candidates);
  }
  if (!aggregatable(fn, column.$meta.kind)) {
    throw notAggregatable(entity.$name, fn, property, column.$meta.kind, candidates);
  }
  return column;
};

/** One amount is one currency at one scale. Two of either have no common unit. */
export interface MoneyUnit {
  readonly currency: string;
  readonly scale: number | null;
}

export const assertOneUnit = <Row>(
  entity: EntityCore<Row>,
  fn: AggregateFn,
  property: string,
  units: readonly MoneyUnit[],
): MoneyUnit | undefined => {
  const seen = new Map<string, MoneyUnit>();
  for (const unit of units) seen.set(`${unit.currency}/${unit.scale ?? ''}`, unit);
  if (seen.size > 1) {
    throw mixedCurrency(entity.$name, fn, property, [...seen.values()].map(unitLabel));
  }
  return [...seen.values()][0];
};

/**
 * What the refusal names. The scale rides along because it is half of what makes two amounts
 * incomparable: `{ minor: 5, currency: 'USD' }` is five cents and `{ minor: 5, currency: 'USD',
 * scale: 6 }` is five millionths of a dollar, and adding them is a 10,000x error with no symptom.
 */
const unitLabel = (unit: MoneyUnit): string =>
  unit.scale === null ? unit.currency : `${unit.currency}@${unit.scale}`;

/**
 * The minor unit an aggregate answers with, narrowed exactly where every other reader of that
 * column narrows it. The column is `bigint` and `MoneyValue.minor` is a `number`, so a total past
 * ±2^53 is a REFUSAL and never a rounded amount — the same bound `parseMinor` applies to one row,
 * applied to the sum of many, where it is far easier to reach.
 */
export const aggregateMinor = <Row>(
  entity: EntityCore<Row>,
  fn: AggregateFn,
  property: string,
  total: string,
): number => {
  const units = BigInt(total);
  if (units <= BigInt(Number.MAX_SAFE_INTEGER) && units >= BigInt(-Number.MAX_SAFE_INTEGER)) {
    return Number(units);
  }
  throw new EntityError({
    code: 'X_AGGREGATE_UNSUPPORTED',
    cause: `${entity.$name}.${fn}('${property}') is ${total} minor units, past ±2^53 — no JS number holds it and MoneyValue.minor is one`,
    fix: `${entity.$name}.andWhere(…).${fn}('${property}')   # narrow the rows, or read the total as text with a hand-written statement`,
  });
};
