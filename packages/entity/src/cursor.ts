// Single responsibility: the keyset cursor — one opaque string that names a position in a sort
// order. Both drivers encode and read the same one, so a page taken in a test against memory
// means the same thing as a page taken in production against Postgres.
//
// It carries the sort VALUES, not just an id: seeking by id alone needs the row to still exist,
// and a row deleted between two pages would silently restart pagination at the top.

import type { EntityCore } from './entity';
import { invariantViolated } from './errors';
import type { AnyColumn, ColumnKind } from './types';

export interface Cursor {
  /** The sort position, rendered for humans and logs. Never parsed back. */
  readonly key: string;
  /** Primary key of the last row on the page. */
  readonly id: string;
  /** One string per sort key, in `orderBy` order. Absent on a cursor from an older release. */
  readonly values?: readonly string[];
}

// A cursor travels in a query string and now carries row values, so the encoding has to survive
// both: base64url (no `+`, `/` or `=` for a caller to re-encode) over UTF-8 bytes (`btoa` alone
// throws above code point 0xFF — one accented title would otherwise break pagination).
const toBase64Url = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const fromBase64Url = (encoded: string): string => {
  const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};

export const encodeCursor = (key: string, id: string, values?: readonly string[]): string =>
  toBase64Url(JSON.stringify(values === undefined ? { k: key, id } : { k: key, id, v: values }));

export const decodeCursor = (cursor: string): Cursor | null => {
  try {
    const parsed: { k?: unknown; id?: unknown; v?: unknown } = JSON.parse(fromBase64Url(cursor));
    if (typeof parsed.k !== 'string' || typeof parsed.id !== 'string') return null;
    const values = parsed.v;
    return Array.isArray(values) && values.every((part) => typeof part === 'string')
      ? { key: parsed.k, id: parsed.id, values: values as readonly string[] }
      : { key: parsed.k, id: parsed.id };
  } catch {
    return null;
  }
};

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
export const kindAt = <Row>(entity: EntityCore<Row>, path: string): ColumnKind => {
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
export const serializeSortValue = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return String(value);
};

export const reviveSortValue = (kind: ColumnKind, text: string): unknown => {
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
