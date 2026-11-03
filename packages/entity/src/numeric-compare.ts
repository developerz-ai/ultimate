// Single responsibility: how a NUMBER a column holds is compared — by the column's declared kind,
// never by the JS type in hand. `bigint()` and `decimal()` rows are decimal TEXT, so a `typeof`
// branch answers a different question from the one Postgres answers for the same column.

import { compareDecimalText } from '@ultimat3/core';
import type { ColumnKind } from './types';

/**
 * The kinds whose ROW VALUE is a decimal string (`columns-data.ts`): a JS `bigint` is what
 * `JSON.stringify` throws on and a `number` loses digits past 2^53. This SET is what this package
 * contributes; the comparison is `@ultimat3/core`'s `compareDecimalText`, which a caller with no
 * column kinds (`@ultimat3/query`) deliberately never asks — a `text` column holding `"10"` and
 * `"9"` is ordered lexically by Postgres.
 */
export const DECIMAL_TEXT: ReadonlySet<ColumnKind> = new Set<ColumnKind>(['bigint', 'numeric']);

const isNumber = (value: unknown): value is number | bigint =>
  typeof value === 'bigint' || (typeof value === 'number' && !Number.isNaN(value));

/**
 * A finite operand as PLAIN decimal digits. `String(1e21)` is `"1e+21"` and `String(1e-7)` is
 * `"1e-7"`: both are literals Postgres reads as exact numerics and neither is text
 * `compareDecimalText` reads, so the exponent is applied to the digits here.
 */
export const plainDecimal = (value: number | bigint): string => {
  const text = String(value);
  const parts = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (parts === null) return text;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = parts;
  const shift = Number(exponent);
  const digits = whole + fraction;
  const point = whole.length + shift;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits.padEnd(point, '0')}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
};

/** Either side may be the JS number: a cursor revives one, and one driver returns one. */
const plain = (value: unknown): unknown => (isNumber(value) ? plainDecimal(value) : value);

/**
 * `-1`, `0` or `1` for a column value against an operand — or `undefined` when the pair is not a
 * numeric comparison at all (a NULL, a string in an integer column), which every caller reads as
 * "the rule does not hold".
 *
 * `decimal` is the COLUMN's declared kind, not a guess from the value: a `text` column holding
 * digits never reaches here as a number.
 */
export const numericOrder = (
  decimal: boolean,
  value: unknown,
  operand: unknown,
): number | undefined => {
  if (decimal) return compareDecimalText(plain(value), plain(operand));
  if (!isNumber(value) || !isNumber(operand)) return undefined;
  return value < operand ? -1 : value > operand ? 1 : 0;
};

const INTEGER_TEXT = /^[+-]?\d+$/;
const DECIMAL_PARTS = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Past this an exponent would have the padding below build a string nobody asked for. */
const MAX_EXPONENT = 1000;

const textOf = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim();
  return isNumber(value) ? plainDecimal(value) : undefined;
};

/**
 * One spelling for the value an integer column compares by: `'007'`, `'+7'`, `7` and `7n` are one
 * key to Postgres. `undefined` for what such a column cannot hold (`'7.0'`, `''`, which `BigInt`
 * alone would read as `0`), so a caller keeps it as written and the server answers its own refusal.
 */
export const canonicalInteger = (value: unknown): string | undefined => {
  const text = textOf(value);
  return text !== undefined && INTEGER_TEXT.test(text) ? BigInt(text).toString() : undefined;
};

/**
 * One spelling for the value a `numeric` compares by: `'2.5'`, `'2.50'` and `'+02.500'` are one
 * value and one unique key, and a `numeric` has one zero. Answers what `numericOrder` calls equal,
 * plus the literals Postgres also reads (`'.5'`, `'5.'`, `'1e3'`). `undefined` when it is no such
 * literal, for the same reason as above.
 */
export const canonicalDecimal = (value: unknown): string | undefined => {
  const parts = DECIMAL_PARTS.exec(textOf(value) ?? 'not a decimal');
  if (parts === null) return undefined;
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = parts;
  const shift = Number(exponent);
  if (whole.length + fraction.length === 0 || Math.abs(shift) > MAX_EXPONENT) return undefined;
  const digits = whole + fraction;
  const point = whole.length + shift;
  const integer = point <= 0 ? '' : digits.slice(0, point).padEnd(point, '0');
  const rest = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  const before = integer.replace(/^0+/, '') || '0';
  const after = rest.replace(/0+$/, '');
  const unsigned = after === '' ? before : `${before}.${after}`;
  return sign === '-' && unsigned !== '0' ? `-${unsigned}` : unsigned;
};
