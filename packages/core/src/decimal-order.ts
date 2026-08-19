/**
 * Two decimals compared EXACTLY, however long the digits run — the ordering Postgres gives a
 * `numeric` or an `int8`, over the TEXT those columns' row values are.
 *
 * Tier 0 because the values are text and the fix has to be available wherever they arrive.
 * `@ultimat3/entity`'s `bigint()` and `decimal()` both hand digits back as a string on purpose — a
 * JS `bigint` is what `JSON.stringify` throws on and a `number` loses digits past 2^53, exactly
 * where a legacy `int8` key lives — so no `typeof` branch catches them: `String(left) <
 * String(right)` answered `["10","100","2","9"]` where the database answers `["2","9","10","100"]`,
 * and a keyset page boundary was cut where the database never cuts one.
 *
 * It answers `undefined` rather than guessing, and that is the whole of its contract: a caller
 * that knows the column's declared kind (`@ultimat3/entity`'s `compareByKind`) asks; a caller that
 * does NOT know it — `@ultimat3/query`, whose `OrderKey` is a name and a direction — must not,
 * because Postgres orders a `text` column holding `"10"` and `"9"` lexically and a comparator
 * guessing "both sides look like decimals" would disagree with the SQL it printed.
 */

/** A decimal, split so two of them can be compared exactly however long the digits run. */
interface Decimal {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

const DECIMAL_SHAPE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * The digits, or `undefined` for anything that is not a plain decimal — an exponent
 * (`String(1e21)` is `"1e+21"`), a `NaN`, an empty string. Those are not values a `numeric` column
 * can hold, so they are not values Postgres would be ordering either.
 */
function decimalOf(value: unknown): Decimal | undefined {
  const text =
    typeof value === 'bigint' || typeof value === 'number'
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : undefined;
  const parts = text === undefined ? null : DECIMAL_SHAPE.exec(text);
  const whole = parts?.[2];
  if (parts === null || whole === undefined) return undefined;
  return { negative: parts[1] === '-', whole, fraction: parts[3] ?? '' };
}

/**
 * Exact at any width: the fractions are padded to one length and both sides become one integer, so
 * a 38-digit `numeric` orders by its digits rather than by whatever a `Number` rounded it to.
 */
function compare(left: Decimal, right: Decimal): number {
  if (left.negative !== right.negative) return left.negative ? -1 : 1;
  const width = Math.max(left.fraction.length, right.fraction.length);
  const scaled = (value: Decimal): bigint =>
    BigInt(`${value.whole}${value.fraction.padEnd(width, '0')}`);
  const first = scaled(left);
  const second = scaled(right);
  // Never a subtraction: the difference between two `bigint`s is exact and the return type is a
  // `number`, which cannot hold it.
  const order = first < second ? -1 : first > second ? 1 : 0;
  // Guarded rather than negated: `-0` is a different value from `0` to `Object.is` and to a caller
  // writing `=== 0`, and two equal negatives are a tie.
  return left.negative && order !== 0 ? -order : order;
}

/**
 * `-1`, `0` or `1` for two plain decimals; `undefined` when EITHER side is not one.
 *
 * Both, or neither: one decimal against a value that is not one is not a numeric comparison, and
 * answering for that pair would order a mixed column by a rule the database does not use.
 */
export function compareDecimalText(left: unknown, right: unknown): number | undefined {
  const first = decimalOf(left);
  if (first === undefined) return undefined;
  const second = decimalOf(right);
  return second === undefined ? undefined : compare(first, second);
}
