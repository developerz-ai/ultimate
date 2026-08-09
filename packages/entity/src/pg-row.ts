// Single responsibility: the two-way map between a physical Postgres row and an entity row.
// Three things are not one-to-one and all three live here: the property key is camelCase while
// the column is snake_case, money is one property over two columns, and a value that came back
// from the driver is re-parsed by the column that declared it rather than trusted — int8 arrives
// as a string, timestamptz may arrive as one, and a silent `NaN` is worse than a loud throw.

import { snake } from './column';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { AnyColumn, MoneyValue } from './types';

export type PhysicalRow = Readonly<Record<string, unknown>>;

const MONEY_PARTS = new Set(['minor', 'currency']);

/** `price` -> `price_minor`, `price_currency`. Everything else is one snake_case column. */
export const columnsOf = (property: string, column: AnyColumn): readonly string[] =>
  column.$meta.kind === 'money'
    ? [`${snake(property)}_minor`, `${snake(property)}_currency`]
    : [snake(property)];

/**
 * A predicate or sort key names a property, never a physical column — so `orgId` becomes
 * `org_id` in exactly one place, and a name the entity never declared cannot reach the SQL.
 */
export const physicalName = <Row>(entity: EntityCore<Row>, path: string): string => {
  const [property = path, part] = path.split('.');
  const column = entity.$columns[property];
  if (column === undefined) {
    throw invariantViolated(
      entity.$name,
      'column',
      `no column "${path}" — pick from: ${Object.keys(entity.$columns).join(', ')}`,
    );
  }
  const isMoney = column.$meta.kind === 'money';
  if (part === undefined) {
    if (!isMoney) return snake(property);
    throw invariantViolated(
      entity.$name,
      property,
      `${property} is money: name ${property}.minor or ${property}.currency`,
    );
  }
  if (!isMoney || !MONEY_PARTS.has(part)) {
    throw invariantViolated(entity.$name, property, `${property} has no part "${part}"`);
  }
  return `${snake(property)}_${part}`;
};

/** Every physical column of the entity, in declaration order. */
export const allColumns = <Row>(entity: EntityCore<Row>): readonly string[] =>
  Object.entries(entity.$columns).flatMap(([property, column]) => columnsOf(property, column));

/**
 * Row (or patch) -> the columns to write. Absent properties are skipped rather than nulled,
 * which is what makes the same function serve `insert` and a partial `update`.
 */
export const bindValues = <Row>(
  entity: EntityCore<Row>,
  values: Partial<Row>,
): ReadonlyMap<string, unknown> => {
  const bound = new Map<string, unknown>();
  const record = values as Readonly<Record<string, unknown>>;
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (!Object.hasOwn(record, property)) continue;
    const value = record[property];
    if (column.$meta.kind !== 'money') {
      bound.set(snake(property), value ?? null);
      continue;
    }
    const money = value as MoneyValue | null | undefined;
    bound.set(`${snake(property)}_minor`, money?.minor ?? null);
    bound.set(`${snake(property)}_currency`, money?.currency ?? null);
  }
  return bound;
};

const moneyOf = (source: PhysicalRow, minor: string, currency: string): unknown => {
  const amount = source[minor];
  if (amount === null || amount === undefined) return null;
  return { minor: amount, currency: String(source[currency] ?? '').trim() };
};

/**
 * Physical row -> entity row. A column the projection left out is left out here too, so a
 * `select` narrows the object as well as the statement.
 */
export const decodeRow = <Row>(entity: EntityCore<Row>, source: PhysicalRow): Row => {
  const row: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    const [head, tail] = columnsOf(property, column);
    if (head === undefined || !(head in source)) continue;
    const value = tail === undefined ? source[head] : moneyOf(source, head, tail);
    if (value !== null && value !== undefined) {
      row[property] = column.$parse(value);
      continue;
    }
    if (column.$meta.notNull) {
      throw invariantViolated(
        entity.$name,
        property,
        'the database returned null for a not-null column — the table no longer matches the entity',
      );
    }
    row[property] = null;
  }
  // Every property present was validated by the column that declared it, so this is the row.
  return row as Row;
};
