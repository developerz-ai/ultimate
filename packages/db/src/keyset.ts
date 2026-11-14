// Single responsibility: keyset paging for a raw read — a join the typed handle cannot express.
// The handle's `.after()` keeps its own seek; this is the same position, carried as the column's
// TEXT and bound back cast by kind, so a microsecond the JS `Date` would drop is never dropped.

import type { Page } from '@ultimat3/core';
import {
  assert,
  CursorInvalidError,
  decodeCursor,
  encodeCursor,
  finiteCount,
  pageOf,
  renderCauseValue,
} from '@ultimat3/core';
import { DbError } from './errors';
import { decodePart, encodePart } from './keyset-position';
import { CASTS, type KeysetKey, type KeysetPosition, nullsOf, orderOf, seek } from './keyset-seek';
import { join, raw, type SqlFragment, sql } from './sql';

export type { KeysetKey, KeysetKind } from './keyset-seek';

export interface KeysetOptions {
  /** This read and its arguments: a cursor from another scope is `X_CURSOR_INVALID`. */
  readonly scope: string;
  /** The order, last key the tiebreak. A key not declared `nullable` must be not null on every row. */
  readonly keys: readonly KeysetKey[];
  /** The previous page's `nextCursor`; `null` for the first page. */
  readonly after: string | null;
  readonly limit: number;
}

/** A row as `page` answers it: the `_keyset_<n>` aliases `select` added are gone. */
export type KeysetRow<Row> = Omit<Row, `_keyset_${number}`>;

/** Four fragments to splice — `select …, ${k.select}`, `where ${k.where}`, `order by`, `limit`. */
export interface Keyset {
  readonly select: SqlFragment;
  readonly where: SqlFragment;
  readonly orderBy: SqlFragment;
  /** `limit + 1`: the extra row is how `page` knows there is a next page. */
  readonly limit: SqlFragment;
  /** The rows the statement answered, cut to `limit`, the key aliases stripped. */
  page<Row extends object>(rows: readonly Row[]): Page<KeysetRow<Row>>;
}

const NULL_KEY_FIX =
  "keyset({ keys: [{ column: sql`coalesce(p.published_at, p.created_at)`, kind: 'timestamptz', direction: 'desc' }, …] })  # or order by a not-null column";

const DIRECTIONS: ReadonlySet<string> = new Set(['asc', 'desc']);
const PLACEMENTS: ReadonlySet<string> = new Set(['first', 'last']);

/**
 * A direction and a kind are spliced as SQL text, and a sort read off a query string arrives typed
 * as a `string` the moment it is cast: refused here, before a fragment exists. Lower case only —
 * `'DESC'` would order one way while every `=== 'desc'` below seeks the other.
 */
const assertKey = (key: KeysetKey, at: number): void => {
  assert(
    DIRECTIONS.has(key.direction),
    `keyset() key ${String(at)} has direction ${renderCauseValue(key.direction)}; only 'asc' and 'desc' are spliced into SQL`,
    "keyset({ keys: [{ column: raw('p.created_at'), kind: 'timestamptz', direction: input.dir === 'asc' ? 'asc' : 'desc' }], … })   # map a request's sort onto the two literals",
  );
  assert(
    CASTS.has(key.kind),
    `keyset() key ${String(at)} has kind ${renderCauseValue(key.kind)}, which has no cast to bind a position back with`,
    "keyset({ keys: [{ column: raw('p.created_at'), kind: 'timestamptz', … }] })   # one of: timestamptz, uuid, text, integer, bigint",
  );
  assert(
    key.nulls === undefined || (key.nullable === true && PLACEMENTS.has(key.nulls)),
    `keyset() key ${String(at)} has nulls ${renderCauseValue(key.nulls)}${key.nullable === true ? '' : ' without nullable: true'}; NULL placement is spliced into SQL and only a nullable key has one`,
    "keyset({ keys: [{ column: raw('p.published_at'), kind: 'timestamptz', direction: 'desc', nullable: true, nulls: 'last' }, …] })   # nulls: 'first' | 'last'",
  );
};

/**
 * The last key breaks every tie, so it must be not null: two rows NULL on it are tied forever and
 * one of them falls between pages. Refused at construction, before a row is read.
 */
const assertTiebreak = (keys: readonly KeysetKey[]): void => {
  const last = keys.at(-1);
  if (last?.nullable !== true) return;
  throw new DbError({
    code: 'X_KEYSET_NULL_KEY',
    cause: `keyset() key ${String(keys.length - 1)} (${last.column.text}) is the final tiebreak and is declared nullable: rows NULL on it tie with no order between them`,
    fix: "keyset({ keys: [{ column: raw('p.published_at'), kind: 'timestamptz', direction: 'desc', nullable: true }, { column: raw('p.id'), kind: 'uuid', direction: 'desc' }], … })   # end on a not-null unique key",
    meta: { key: keys.length - 1 },
  });
};

const aliasOf = (index: number): string => `_keyset_${String(index)}`;

/**
 * The scope the cursor is signed under: the caller's, plus the order itself — so a cursor minted
 * under `desc` cannot seek an `asc` read, nor a `uuid` key be bound back as `text`. Hashed: the
 * key expressions are the statement's, not the client's to read. A nullable key adds its NULL
 * placement; a not-null key's scope is unchanged, so a cursor minted before nullable keys pages on.
 */
const scopeOf = (scope: string, keys: readonly KeysetKey[]): string => {
  const order = keys
    .map(
      (key) =>
        `${key.column.text}${JSON.stringify(key.column.values.map(String))} ${key.kind} ${key.direction}${key.nullable === true ? ` nulls ${nullsOf(key)}` : ''}`,
    )
    .join(',');
  const digest = new Bun.CryptoHasher('sha256').update(`${scope}|${order}`).digest('hex');
  return `keyset:${digest.slice(0, 16)}`;
};

const positionOf = (cursor: string, scope: string, keys: readonly KeysetKey[]): KeysetPosition => {
  const { key } = decodeCursor(cursor, scope);
  if (key.length !== keys.length) {
    throw new CursorInvalidError(
      `it carries ${key.length} key values, this order needs ${keys.length}`,
    );
  }
  return keys.map((spec, at) => {
    const value = decodePart(spec, key[at]);
    if (value === undefined) {
      throw new CursorInvalidError(`key value ${String(at)} is not a position this order can seek`);
    }
    return value;
  });
};

/** Every key of `row`, as the text the server answered — refused when an undeclared one is null. */
const keyText = (row: object, keys: readonly KeysetKey[], index: number): (string | null)[] =>
  keys.map((key, at) => {
    const value: unknown = Reflect.get(row, aliasOf(at));
    if (typeof value === 'string') return value;
    if (value === null && key.nullable === true) return null;
    if (value === null) {
      throw new DbError({
        code: 'X_KEYSET_NULL_KEY',
        cause: `row ${String(index)} holds null in keyset key ${String(at)} (${key.column.text}): a row comparison has no null order, so that row and every one like it would fall off the next page`,
        fix: NULL_KEY_FIX,
        meta: { key: at, row: index },
      });
    }
    throw new DbError({
      code: 'X_INVARIANT',
      cause: `row ${String(index)} carries no ${aliasOf(at)}: the statement did not select keyset()'s keys`,
      fix: "db().query(sql`select p.*, <k.select> from … where <k.where> order by <k.orderBy> limit <k.limit>`)  # each <…> an interpolation of keyset()'s answer",
      meta: { key: at, row: index },
    });
  });

const stripped = <Row extends object>(row: Row, aliases: ReadonlySet<string>): KeysetRow<Row> =>
  Object.fromEntries(Object.entries(row).filter(([name]) => !aliases.has(name))) as KeysetRow<Row>;

/**
 * A keyset page over any statement. The key is selected as `col::text` and bound back as
 * `$n::<kind>`: exact, no arithmetic, and the `order by` stays on the bare column, so an index on
 * `(created_at desc, id desc)` answers it as an Index Only Scan.
 */
export function keyset(options: KeysetOptions): Keyset {
  const { keys } = options;
  assert(
    keys.length > 0,
    'keyset() was given no keys, so it has no order to page by',
    "keyset({ keys: [{ column: raw('p.created_at'), kind: 'timestamptz', direction: 'desc' }, { column: raw('p.id'), kind: 'uuid', direction: 'desc' }], … })",
  );
  assert(
    options.scope.length > 0,
    'keyset() was given an empty scope, so a cursor from any other raw read would page this one',
    "keyset({ scope: 'posts.feed', … })   # one name per read, plus its filter arguments",
  );
  keys.forEach(assertKey);
  assertTiebreak(keys);
  const limit = finiteCount('keyset', 'limit', options.limit, 1);
  const scope = scopeOf(options.scope, keys);
  const where =
    options.after === null ? sql`true` : seek(keys, positionOf(options.after, scope, keys));
  return {
    select: join(keys.map((key, at) => sql`${key.column}::text as ${raw(`"${aliasOf(at)}"`)}`)),
    where,
    orderBy: join(keys.map(orderOf)),
    limit: sql`${limit + 1}`,
    page<Row extends object>(rows: readonly Row[]): Page<KeysetRow<Row>> {
      const positions = rows.map((row, index) => keyText(row, keys, index));
      const aliases = new Set(keys.map((_key, at) => aliasOf(at)));
      const kept = rows.slice(0, limit).map((row) => stripped(row, aliases));
      const last = positions[limit - 1];
      const next =
        rows.length > limit && last !== undefined
          ? encodeCursor({
              scope,
              key: last.map((value, at) => encodePart(keys[at], value)),
              id: '',
            })
          : null;
      return pageOf(kept, next);
    },
  };
}
