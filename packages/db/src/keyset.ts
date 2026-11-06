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
} from '@ultimat3/core';
import { DbError } from './errors';
import { join, raw, type SqlFragment, sql } from './sql';

/** The kinds a position can be bound back as, each with its own cast. A closed list. */
export type KeysetKind = 'timestamptz' | 'uuid' | 'text' | 'integer' | 'bigint';

export interface KeysetKey {
  /** The ordered expression as written in the statement: `raw('p.created_at')`, or a `sql` one. */
  readonly column: SqlFragment;
  readonly kind: KeysetKind;
  readonly direction: 'asc' | 'desc';
}

export interface KeysetOptions {
  /** This read and its arguments: a cursor from another scope is `X_CURSOR_INVALID`. */
  readonly scope: string;
  /** The order, last key the tiebreak. Every key must be not null on every row. */
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

const CASTS: ReadonlyMap<KeysetKind, string> = new Map<KeysetKind, string>([
  ['timestamptz', 'timestamptz'],
  ['uuid', 'uuid'],
  ['text', 'text'],
  ['integer', 'integer'],
  ['bigint', 'bigint'],
]);

const NULL_KEY_FIX =
  "keyset({ keys: [{ column: sql`coalesce(p.published_at, p.created_at)`, kind: 'timestamptz', direction: 'desc' }, …] })  # or order by a not-null column";

const aliasOf = (index: number): string => `_keyset_${String(index)}`;

/**
 * The scope the cursor is signed under: the caller's, plus the order itself — so a cursor minted
 * under `desc` cannot seek an `asc` read, nor a `uuid` key be bound back as `text`. Hashed: the
 * key expressions are the statement's, not the client's to read.
 */
const scopeOf = (scope: string, keys: readonly KeysetKey[]): string => {
  const order = keys
    .map(
      (key) =>
        `${key.column.text}${JSON.stringify(key.column.values.map(String))} ${key.kind} ${key.direction}`,
    )
    .join(',');
  const digest = new Bun.CryptoHasher('sha256').update(`${scope}|${order}`).digest('hex');
  return `keyset:${digest.slice(0, 16)}`;
};

const bind = (key: KeysetKey, text: string): SqlFragment =>
  sql`${text}::${raw(CASTS.get(key.kind) ?? 'text')}`;

const past = (key: KeysetKey, value: SqlFragment): SqlFragment =>
  sql`${key.column} ${raw(key.direction === 'desc' ? '<' : '>')} ${value}`;

/**
 * Uniform direction is ONE row comparison, the shape Postgres pushes into a multicolumn index as
 * an Index Cond. A mixed order has none, so it is the or-chain — the same split as the entity
 * driver's `seekSql`. No null branch in either: `page` refuses a null key before it is a cursor.
 */
const seek = (keys: readonly KeysetKey[], position: readonly string[]): SqlFragment => {
  const binds = (): SqlFragment[] => keys.map((key, index) => bind(key, position[index] ?? ''));
  const [first] = keys;
  if (first === undefined) return sql`true`;
  if (keys.length === 1) return past(first, bind(first, position[0] ?? ''));
  if (keys.every((key) => key.direction === first.direction)) {
    const op = raw(first.direction === 'desc' ? '<' : '>');
    return sql`(${join(keys.map((key) => key.column))}) ${op} (${join(binds())})`;
  }
  const terms = keys.map((key, index) => {
    const equal = keys
      .slice(0, index)
      .map((prior, at) => sql`${prior.column} = ${bind(prior, position[at] ?? '')}`);
    const term = past(key, bind(key, position[index] ?? ''));
    return equal.length === 0 ? term : sql`(${join([...equal, term], ' and ')})`;
  });
  return sql`(${join(terms, ' or ')})`;
};

const positionOf = (cursor: string, scope: string, keys: readonly KeysetKey[]): string[] => {
  const { key } = decodeCursor(cursor, scope);
  if (key.length !== keys.length || !key.every((part) => typeof part === 'string')) {
    throw new CursorInvalidError(
      `it carries ${key.length} key values, this order needs ${keys.length}`,
    );
  }
  return key as string[];
};

/** Every key of `row`, as the text the server answered — refused when one is null. */
const keyText = (row: object, keys: readonly KeysetKey[], index: number): string[] =>
  keys.map((key, at) => {
    const value: unknown = Reflect.get(row, aliasOf(at));
    if (typeof value === 'string') return value;
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
  const limit = finiteCount('keyset', 'limit', options.limit, 1);
  const scope = scopeOf(options.scope, keys);
  const where =
    options.after === null ? sql`true` : seek(keys, positionOf(options.after, scope, keys));
  return {
    select: join(keys.map((key, at) => sql`${key.column}::text as ${raw(`"${aliasOf(at)}"`)}`)),
    where,
    orderBy: join(keys.map((key) => sql`${key.column} ${raw(key.direction)}`)),
    limit: sql`${limit + 1}`,
    page<Row extends object>(rows: readonly Row[]): Page<KeysetRow<Row>> {
      const positions = rows.map((row, index) => keyText(row, keys, index));
      const aliases = new Set(keys.map((_key, at) => aliasOf(at)));
      const kept = rows.slice(0, limit).map((row) => stripped(row, aliases));
      const last = positions[limit - 1];
      const next =
        rows.length > limit && last !== undefined
          ? encodeCursor({ scope, key: last, id: '' })
          : null;
      return pageOf(kept, next);
    },
  };
}
