// Single responsibility: what an entity cursor *means*. The codec is `@ultimat3/core`'s — this
// file decides what a page position is bound to (the plan that produced it) and how a sort value
// survives the round trip (the column's kind).
//
// Both drivers call `cursorFor` and `seekFrom` and nothing else, so a rule added to one is added
// to both. The cursor carries the sort VALUES, not just an id: seeking by id alone needs the row
// to still exist, and a row deleted between two pages would silently restart pagination.

import { CursorInvalidError, decodeCursor, encodeCursor } from '@ultimat3/core';
import { columnFor } from './column';
import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { QueryPlan } from './tenancy';
import type { AnyColumn, ColumnKind } from './types';

/**
 * The kind a money part is *revived* as, which is the kind the row property holds — not the
 * physical column's. `<p>_minor` is a `bigint` column, but `MoneyValue.minor` is a `number`
 * (`@ultimat3/schema` owns that declaration), and a cursor whose value came back a `bigint`
 * would compare against a `number` property in the memory driver and mint a seek bind of the
 * wrong type in the other. The narrowing itself is guarded once, where the row is decoded.
 */
const MONEY_PARTS: Readonly<Record<string, ColumnKind>> = { minor: 'integer', currency: 'char' };

/** Resolves `price.minor` as well as `title`; money is the one property with two parts. */
const partsOf = (path: string): { readonly property: string; readonly part?: string } => {
  const [property = path, part] = path.split('.');
  return part === undefined ? { property } : { property, part };
};

const columnAt = <Row>(entity: EntityCore<Row>, path: string): AnyColumn => {
  const column = columnFor(entity.$columns, partsOf(path).property);
  if (column === undefined) {
    throw invariantViolated(entity.$name, 'orderBy', `no column "${path}"`);
  }
  return column;
};

/** The physical type a sort key holds — what tells `revive` how to read its string back. */
const kindAt = <Row>(entity: EntityCore<Row>, path: string): ColumnKind => {
  const { part } = partsOf(path);
  const kind = columnAt(entity, path).$meta.kind;
  if (part === undefined) {
    // Money is two physical columns, so the property alone names no single sort value: the
    // cursor would carry `String({ minor, currency })` and the next page would fail parsing it
    // as a bare `SyntaxError` from `BigInt`, with no code and no fix. `entity()` refuses the
    // same path in `resolve()`; refusing it here keeps one answer for one mistake.
    if (kind !== 'money') return kind;
    throw invariantViolated(
      entity.$name,
      'orderBy',
      `${path} is money: order by ${path}.minor or ${path}.currency`,
    );
  }
  // `MONEY_PARTS[part]` alone answers a FUNCTION for `orderBy('price.toString')` — not
  // `undefined` — so the refusal below never fired and `assertSeekable` minted a cursor for it.
  const money =
    kind === 'money' && Object.hasOwn(MONEY_PARTS, part) ? MONEY_PARTS[part] : undefined;
  if (money === undefined) {
    throw invariantViolated(entity.$name, 'orderBy', `${path} names no column part`);
  }
  return money;
};

/**
 * The kind a PATH holds, or `undefined` when it names none — the non-throwing half of `kindAt`.
 *
 * The in-memory driver asks this about a predicate column and a sort key, both of which are caller
 * data: an unknown name compares as text there exactly as it always did, rather than turning a
 * filter into a refusal the Postgres driver does not make. It is what lets a comparison be decided
 * by the column's DECLARED kind — which is what Postgres decides by — instead of by the JS type of
 * whichever value is in hand.
 */
export const kindOf = <Row>(entity: EntityCore<Row>, path: string): ColumnKind | undefined => {
  const { property, part } = partsOf(path);
  const kind = columnFor(entity.$columns, property)?.$meta.kind;
  if (kind === undefined) return undefined;
  if (part === undefined) return kind === 'money' ? undefined : kind;
  return kind === 'money' && Object.hasOwn(MONEY_PARTS, part) ? MONEY_PARTS[part] : undefined;
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

// No `money` case: `kindAt` resolves a money sort key to the kind of the part being ordered by
// and refuses the bare property, so the composite kind never reaches here. A case for it could
// only ever revive "[object Object]".
//
// The parts revive as `MONEY_PARTS` declares them — `minor` as an `integer` and `currency` as a
// `char` — and `minor` is deliberately NOT `bigint` even though the physical column is: the row
// property is a `number` (`@ultimat3/schema` owns that declaration), and a cursor reviving a
// `bigint` there would compare against a `number` property in the memory driver and mint a seek
// bind of the wrong type in the other. The comment here used to claim the opposite of the
// constant three lines above it.
const reviveSortValue = (kind: ColumnKind, text: string): unknown => {
  switch (kind) {
    case 'timestamptz':
      return new Date(text);
    case 'bigint':
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
 *
 * Checked when a cursor is minted as well as when one is decoded: an ordering that cannot carry
 * a position is the author's mistake, and reporting it on the *second* page hides it behind
 * whatever page size the caller happened to use.
 */
export const assertSeekable = <Row>(
  entity: EntityCore<Row>,
  orderBy: readonly { readonly column: string }[],
): void => {
  for (const key of orderBy) {
    // Resolving the kind is the other half: it refuses a column the entity never declared and a
    // money property named without its part — both mint a cursor nothing can decode.
    kindAt(entity, key.column);
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
export const cursorFor = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  row: unknown,
  id: string,
): string => {
  assertSeekable(entity, plan.orderBy);
  return encodeCursor({
    scope: planScope(plan),
    key: plan.orderBy.map((entry) => serializeSortValue(valueAt(row, entry.column))),
    id,
  });
};

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
