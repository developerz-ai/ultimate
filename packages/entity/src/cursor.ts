// Single responsibility: what an entity cursor *means*. The codec is `@ultimat3/core`'s — this
// file decides what a page position is bound to (the plan that produced it) and how a sort value
// survives the round trip (the column's kind).
//
// Both drivers call `cursorFor` and `seekFrom` and nothing else, so a rule added to one is added
// to both. The cursor carries the sort VALUES, not just an id: seeking by id alone needs the row
// to still exist, and a row deleted between two pages would silently restart pagination.

import { CursorInvalidError, decodeCursor, encodeCursor } from '@ultimat3/core';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { QueryPlan } from './tenancy';
import type { AnyColumn, ColumnKind } from './types';

const MONEY_PARTS: Readonly<Record<string, ColumnKind>> = { minor: 'bigint', currency: 'char' };

/** Resolves `price.minor` as well as `title`; money is the one property with two parts. */
const partsOf = (path: string): { readonly property: string; readonly part?: string } => {
  const [property = path, part] = path.split('.');
  return part === undefined ? { property } : { property, part };
};

const columnAt = <Row>(entity: EntityCore<Row>, path: string): AnyColumn => {
  const column = entity.$columns[partsOf(path).property];
  if (column === undefined) {
    throw invariantViolated(entity.$name, 'orderBy', `no column "${path}"`);
  }
  return column;
};

/** The physical type a sort key holds — what tells `revive` how to read its string back. */
const kindAt = <Row>(entity: EntityCore<Row>, path: string): ColumnKind => {
  const { part } = partsOf(path);
  const kind = columnAt(entity, path).$meta.kind;
  if (part === undefined) return kind;
  const money = kind === 'money' ? MONEY_PARTS[part] : undefined;
  if (money === undefined) {
    throw invariantViolated(entity.$name, 'orderBy', `${path} names no column part`);
  }
  return money;
};

export const valueAt = (row: unknown, path: string): unknown => {
  const { property, part } = partsOf(path);
  const record = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
  const base = record[property];
  if (part === undefined) return base;
  return typeof base === 'object' && base !== null
    ? (base as Record<string, unknown>)[part]
    : undefined;
};

/** Stringified so the cursor is JSON; `revive` restores the type from the column's kind. */
const serializeSortValue = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return String(value);
};

const reviveSortValue = (kind: ColumnKind, text: string): unknown => {
  switch (kind) {
    case 'timestamptz':
      return new Date(text);
    case 'bigint':
    case 'money':
      return BigInt(text);
    case 'integer':
      return Number(text);
    case 'boolean':
      return text === 'true';
    default:
      return text;
  }
};

/**
 * A keyset seek only has a total order when every sort column is present on every row —
 * `null > 'x'` is unknown in SQL and would drop rows from the middle of a listing.
 */
export const assertSeekable = <Row>(
  entity: EntityCore<Row>,
  orderBy: readonly { readonly column: string }[],
): void => {
  for (const key of orderBy) {
    if (columnAt(entity, key.column).$meta.notNull) continue;
    throw invariantViolated(
      entity.$name,
      'cursor',
      `${key.column} is nullable and cannot carry a cursor — order by a not-null column ` +
        `(add .orderBy('${entity.$primaryKey[0] ?? 'id'}') or make ${key.column} not null)`,
    );
  }
};

/** Deterministic, and total over the value shapes a predicate can hold. */
const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) return `[${value.map(renderValue).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${key}:${renderValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
};

/**
 * What a cursor is bound to: this entity, these filters, this sort order. Not the page size — a
 * client may legitimately ask for a bigger next page — and not the projection, which cannot move
 * a row's position. Filters are sorted because `and` is commutative, so two chains that build the
 * same predicate set page each other's cursors.
 *
 * Hashed rather than spelled out: a cursor is base64, not encrypted, and the caller's filter
 * values are not the client's to read.
 */
export const planScope = (plan: QueryPlan): string => {
  const where = plan.where
    .map((predicate) => `${predicate.column} ${predicate.op} ${renderValue(predicate.value)}`)
    .sort()
    .join('&');
  const order = plan.orderBy.map((key) => `${key.column} ${key.direction}`).join(',');
  return new Bun.CryptoHasher('sha256')
    .update(`${plan.entity}|${where}|${order}`)
    .digest('hex')
    .slice(0, 16);
};

/** The cursor that continues this plan after `row`. Signed by core, scoped by the plan. */
export const cursorFor = (plan: QueryPlan, row: unknown, id: string): string =>
  encodeCursor({
    scope: planScope(plan),
    key: plan.orderBy.map((entry) => serializeSortValue(valueAt(row, entry.column))),
    id,
  });

/**
 * The keyset position a plan resumes from, revived to the types its columns hold — `undefined`
 * when the plan has no cursor. A cursor that was tampered with, or taken from another entity,
 * another filter or another sort order, is `X_CURSOR_INVALID` here rather than a silent page one.
 */
export const seekFrom = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
): readonly unknown[] | undefined => {
  if (plan.cursor === undefined) return undefined;
  const { key } = decodeCursor(plan.cursor, planScope(plan));
  assertSeekable(entity, plan.orderBy);
  // Unreachable through the scope check, which already pins the sort order — kept because the
  // alternative to a bad arity is `?? ''`, and that seeks from an empty string.
  if (key.length !== plan.orderBy.length) {
    throw new CursorInvalidError(
      `it carries ${key.length} sort values, this order needs ${plan.orderBy.length}`,
    );
  }
  return plan.orderBy.map((entry, index) =>
    reviveSortValue(kindAt(entity, entry.column), String(key[index])),
  );
};
