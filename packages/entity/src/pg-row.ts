// Single responsibility: the two-way map between a physical Postgres row and an entity row.
// Three things are not one-to-one and all three live here: the property key is camelCase while
// the column is snake_case, money is one property over two columns, and a value that came back
// from the driver is re-parsed by the column that declared it rather than trusted — int8 arrives
// as a string, timestamptz may arrive as one, and a silent `NaN` is worse than a loud throw.

import { columnName, moneyColumns } from './column';
import { narrowMoney } from './columns';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { AnyColumn, MoneyValue } from './types';

export type PhysicalRow = Readonly<Record<string, unknown>>;

const MONEY_PARTS = new Set(['minor', 'currency']);

/**
 * `price` -> `price_minor`, `price_currency`, `price_scale`. Everything else is one snake_case
 * column.
 *
 * The scale column is nullable and is the only one of the three an amount may omit: `null` means
 * "the currency's own minor unit", which is every row written before the column existed. It is NOT
 * addressable as a predicate or a sort key (`MONEY_PARTS` below, and `cursor.ts`'s copy) — a scale
 * says which units `minor` counts, so ordering or filtering by it compares two different questions.
 */
export const columnsOf = (property: string, column: AnyColumn): readonly string[] => {
  if (column.$meta.kind !== 'money') return [columnName(property, column.$meta)];
  const parts = moneyColumns(property, column.$meta);
  // Two columns for an adopted amount that has no scale column: the list IS the projection, so a
  // name here that the table does not have is a `42703` on the first select.
  return parts.scale === null
    ? [parts.minor, parts.currency]
    : [parts.minor, parts.currency, parts.scale];
};

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
    if (!isMoney) return columnName(property, column.$meta);
    throw invariantViolated(
      entity.$name,
      property,
      `${property} is money: name ${property}.minor or ${property}.currency`,
    );
  }
  if (!isMoney || !MONEY_PARTS.has(part)) {
    throw invariantViolated(entity.$name, property, `${property} has no part "${part}"`);
  }
  const parts = moneyColumns(property, column.$meta);
  return part === 'minor' ? parts.minor : parts.currency;
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
  // `MoneyInput` lets a writer hand a `bigint`; the row type is `MoneyValue`. `memoryRepo` calls
  // the same narrowing before it stores, so what the two drivers write is one value.
  const record = narrowMoney(entity.$columns, values) as Readonly<Record<string, unknown>>;
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (!Object.hasOwn(record, property)) continue;
    const value = record[property];
    if (column.$meta.kind !== 'money') {
      bound.set(columnName(property, column.$meta), bindable(column, value));
      continue;
    }
    const parts = moneyColumns(property, column.$meta);
    const money = value as MoneyValue | null | undefined;
    bound.set(parts.minor, money?.minor ?? null);
    bound.set(parts.currency, money?.currency ?? null);
    // `?? null` and not `!== undefined`: an amount at the currency's own scale carries no key at
    // all, and that absence is what the nullable column stores. A `0` written here for it would
    // claim whole units — a 100x reinterpretation of every ordinary price.
    if (parts.scale !== null) bound.set(parts.scale, money?.scale ?? null);
  }
  return bound;
};

/**
 * One array element, as a Postgres array literal spells it. Quoted always: an unquoted element
 * containing a comma, a brace or a backslash is a different array, and an empty string unquoted
 * is nothing at all.
 */
const arrayElement = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  const text =
    value instanceof Date ? value.toISOString() : typeof value === 'object' ? '' : String(value);
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

/**
 * The value a parameter carries. Every column but one hands its row value straight over — the
 * measured driver behaviour is that an object binds to `jsonb`, a string binds to `numeric`,
 * `int8` and `date`, and a `Uint8Array` binds to `bytea`.
 *
 * An array is the one that cannot: Bun's `sql` serialises a JS array to `x,y`, which Postgres
 * answers with `malformed array literal` (measured). What it accepts is the literal, so this is
 * where a JS array becomes one.
 */
const bindable = (column: AnyColumn, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  // A plain object is not a bindable parameter (`X_SQL_UNSAFE`), so a `jsonb` value crosses as its
  // TEXT and `pg-sql.ts`'s cell casts it back — see `cellCast` for why the cast is `::text::jsonb`.
  if (column.$meta.kind === 'jsonb') return JSON.stringify(value);
  if (column.$meta.kind !== 'array' || !Array.isArray(value)) return value;
  return `{${value.map(arrayElement).join(',')}}`;
};

const moneyOf = (
  source: PhysicalRow,
  minor: string,
  currency: string,
  scale: string | undefined,
): unknown => {
  const amount = source[minor];
  if (amount === null || amount === undefined) return null;
  // A column the projection left out is absent, not null — and absent must read as "no scale"
  // exactly as a stored NULL does, so both take the same branch. So does a table that has no
  // scale column at all, which is why the name itself may be `undefined`.
  const declared = scale === undefined ? undefined : source[scale];
  return {
    minor: amount,
    currency: String(source[currency] ?? '').trim(),
    ...(declared === null || declared === undefined ? {} : { scale: declared }),
  };
};

/**
 * Physical row -> entity row. A column the projection left out is left out here too, so a
 * `select` narrows the object as well as the statement.
 */
export const decodeRow = <Row>(entity: EntityCore<Row>, source: PhysicalRow): Row => {
  const row: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    const [head, currency, scale] = columnsOf(property, column);
    if (head === undefined || !(head in source)) continue;
    // Decided by the column's KIND and never by how many names came back: a money column whose
    // table has no scale column projects two names, and reading that as a non-money column handed
    // the caller a raw minor unit where a `Money` belongs.
    const value =
      column.$meta.kind === 'money' && currency !== undefined
        ? moneyOf(source, head, currency, scale)
        : source[head];
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
