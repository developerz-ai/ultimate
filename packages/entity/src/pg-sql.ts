// Single responsibility: compile a `QueryPlan` into parameterised SQL. Nothing here builds a
// string from a value — `sql` binds every scalar to `$n` and refuses anything else — and every
// identifier is resolved through the entity, so a column name can only ever be one the entity
// declared. That is the whole reason this file exists instead of a template literal per method.

import { identifier, join, raw, type SqlFragment, sql } from '@ultimat3/db';
import type { AggregateFn } from './aggregate';
import { AVG_SCALE } from './aggregate';
import { columnFor } from './column';
import { isNullableKey, kindOf } from './cursor';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import { searchUndeclared } from './feature-errors';
import { microsToIso, seekAlias } from './instant';
import { allColumns, arrayLiteral, columnsOf, physicalName } from './pg-row';
import type { Predicate, QueryPlan, SortKey } from './tenancy';
import type { ColumnKind } from './types';

/** Nothing matches. `in ()` is a syntax error in Postgres, so an empty set needs a constant. */
const NEVER = sql`1 = 0`;

export interface ReadShape {
  /** Soft-deleted rows are hidden unless the caller asked for them. */
  readonly includeDeleted: boolean;
  /** The keyset position, already revived to typed values. */
  readonly seek?: readonly unknown[] | undefined;
}

const columnRef = <Row>(entity: EntityCore<Row>, path: string): SqlFragment =>
  identifier(physicalName(entity, path));

/**
 * `websearch_to_tsquery`, and the choice is the point of the whole feature.
 *
 * `to_tsquery` reads its argument as tsquery SYNTAX — `&`, `|`, `!`, `<->`, `:*`, parentheses — so
 * a term straight out of a search box is either a `42601` on the first unbalanced paren or, worse,
 * an operator the caller did not write. `plainto_tsquery` is safe but ANDs every word and throws
 * the user's own operators away silently. `websearch_to_tsquery` is the parser Postgres ships for
 * untrusted input: it never raises a syntax error, and it gives `"quoted phrase"`, `or` and a
 * leading `-` the meaning every search box on the web already has. Cats & dogs is three terms.
 *
 * The term crosses as a BOUND PARAMETER either way — nothing here interpolates it — so the choice
 * is not what stops an injection; the parameter is. What the parser decides is whether the user's
 * punctuation is read as syntax, which is the second half of the same question.
 *
 * The configuration is spliced through `raw()`, from `SEARCH_LANGUAGES`, exactly as `asc|desc` is:
 * a closed set of one word, chosen by this file from the ENTITY's declaration and never from a
 * value on the wire. `regconfig` cannot be a bound parameter and stay index-matchable anyway.
 */
const searchSql = <Row>(entity: EntityCore<Row>, predicate: Predicate): SqlFragment => {
  const vector = entity.$search;
  if (vector === null) throw searchUndeclared(entity.$name);
  const column = identifier(vector.column);
  // The term as TEXT, whatever arrived: `websearch_to_tsquery` takes text, and a number or a null
  // reaching it as a parameter is a `42883` where the caller is owed "no rows".
  const term = predicate.value === null || predicate.value === undefined ? '' : predicate.value;
  return sql`${column} @@ websearch_to_tsquery(${raw(`'${vector.language}'`)}, ${String(term)})`;
};

const predicateSql = <Row>(entity: EntityCore<Row>, predicate: Predicate): SqlFragment => {
  // BEFORE the column is resolved: a `matches` predicate names `SEARCH_PROPERTY`, which is not a
  // column and must never be looked up as one.
  if (predicate.op === 'matches') return searchSql(entity, predicate);
  const column = columnRef(entity, predicate.column);
  const value = predicate.value;
  switch (predicate.op) {
    case 'eq':
      return value === null ? sql`${column} is null` : sql`${column} = ${value}`;
    case 'neq':
      // `is distinct from` so a null on either side compares as a value, not as unknown.
      return sql`${column} is distinct from ${value}`;
    case 'in': {
      // `in` reads a LIST or nothing. A scalar used to be wrapped into a one-element list, which
      // matched a row here that `memoryRepo`'s `matches` refuses outright — 0 rows in memory, 1 in
      // Postgres, from a call `andWhere(column, op, value: unknown)` compiles. One answer, and it
      // is the one `@ultimat3/query`'s `filterClause` already gives: no rows.
      if (!Array.isArray(value)) return NEVER;
      // A NULL bound as a parameter is `col = null`, which is UNKNOWN and therefore excludes the
      // very row the caller listed — while memory's `sameValue(null, null)` includes it. Postgres
      // has no `in` that compares a null as a value, so the list is partitioned and the nulls are
      // asked for as `is null`: the `(… in (…) or … is null)` pair `eq` and `neq` already emit.
      const present = value.filter((each) => each !== null && each !== undefined);
      const list =
        present.length === 0
          ? undefined
          : sql`${column} in (${join(present.map((e) => sql`${e}`))})`;
      const nulls = present.length === value.length ? undefined : sql`${column} is null`;
      if (list === undefined) return nulls ?? NEVER;
      return nulls === undefined ? list : sql`(${list} or ${nulls})`;
    }
    case 'gt':
      return sql`${column} > ${value}`;
    case 'gte':
      return sql`${column} >= ${value}`;
    case 'lt':
      return sql`${column} < ${value}`;
    case 'lte':
      return sql`${column} <= ${value}`;
    case 'like':
      return sql`${column} like ${value}`;
    case 'is-null':
      return sql`${column} is null`;
    case 'is-not-null':
      return sql`${column} is not null`;
    // The containment half. The OPERAND crosses as a bound parameter in every one of them — a
    // jsonb operand as its TEXT with the same `::text::jsonb` cast an insert cell uses (the driver
    // seam refuses a plain object as a parameter), an array operand as the array literal
    // `bindValues` already builds. What is written into the statement is the operator, and the
    // operator is chosen here from a closed set of four.
    case 'contains':
      return containmentSql(entity, predicate, 'contains');
    case 'contained-by':
      return containmentSql(entity, predicate, 'contained-by');
    case 'overlaps':
      return containmentSql(entity, predicate, 'overlaps');
    // The `?` OPERATOR, schema-qualified — not `jsonb_exists(col, $1)`, which is the same test and
    // is **not indexable**. Measured on Postgres 16 over 20,000 rows with a GIN index and
    // `enable_seqscan = off`: `data ? 'k'` plans as a Bitmap Index Scan and
    // `jsonb_exists(data, 'k')` is a Seq Scan the planner will not convert, because an index is
    // matched against an OPERATOR expression and a bare function call is not one. Shipping the
    // function form would have made `has-key` the one containment operator a declared GIN index
    // cannot serve — which is the whole reason the index is declarable.
    //
    // `operator(pg_catalog.?)` rather than a bare `?`: both round-trip through Bun's client today
    // (measured), and the qualified spelling is immune to any client that reads `?` as a
    // placeholder and to a search_path that shadows the operator. Postgres matches the index
    // against it identically — verified in the same EXPLAIN run.
    case 'has-key':
      return sql`${column} operator(pg_catalog.?) ${String(predicate.value)}`;
  }
};

/**
 * A containment operand, cast to the column's own type. `jsonb` is the one that cannot bind as
 * itself — the seam refuses a plain object (`X_SQL_UNSAFE`) — so it crosses as TEXT and the cast
 * turns it back, exactly as an insert cell does; `::text::jsonb` and not `::jsonb`, because with
 * the single cast the client JSON-encodes the string it was given and `{"a":1}` is stored as the
 * JSON *string*.
 */
const containmentSql = <Row>(
  entity: EntityCore<Row>,
  predicate: Predicate,
  op: 'contains' | 'contained-by' | 'overlaps',
): SqlFragment => {
  const column = columnRef(entity, predicate.column);
  const kind = kindOf(entity, predicate.column);
  const operand =
    kind === 'jsonb'
      ? sql`${JSON.stringify(predicate.value ?? null)}::text::jsonb`
      : sql`${arrayLiteral(predicate.value)}`;
  if (op === 'contains') return sql`${column} @> ${operand}`;
  if (op === 'contained-by') return sql`${column} <@ ${operand}`;
  return sql`${column} && ${operand}`;
};

/**
 * The bind a seek compares against, at the precision the COLUMN keeps. Every kind but one binds
 * the revived value itself; a `timestamptz` cursor carries MICROSECONDS since the epoch
 * (`cursor.ts`), because binding a JS `Date` is the row's own position floored to the millisecond
 * — and the `order by` beside it sorts at microseconds, so the two ranked rows differently and a
 * `desc` page dropped every row inside the boundary millisecond. Proven against a real server:
 * `pg-cursor-precision.live.test.ts`.
 *
 * The cast is part of this template and not a `raw()` call: what crosses as a parameter is the ISO
 * text, and `${…}::timestamptz` is what makes the server parse it as an instant rather than infer
 * a type for it. The column stays BARE on the left, so an index can still range-scan.
 */
const seekBind = (kind: ColumnKind | undefined, value: unknown): SqlFragment | null => {
  // `null` and not a bound parameter: NULL is never the VALUE being tested, it is the shape of the
  // term. `col = $n` and `col > $n` are both unknown against a NULL bind, so binding one would
  // answer no rows where the ordering says there are some.
  if (value === null || value === undefined) return null;
  return kind === 'timestamptz' && typeof value === 'bigint'
    ? sql`${microsToIso(value)}::timestamptz`
    : sql`${value}`;
};

/**
 * Strictly past the cursor's position in this key's direction, under the ordering `orderSql`
 * writes — so NULL is the largest value on both sides of the comparison.
 *
 * `desc` is `nulls first`: a NULL cursor is at the very top, and every non-null row follows it
 * (`is not null`); a value cursor's `< $n` already excludes the NULLs above it. `asc` is
 * `nulls last`: the NULLs follow every value, so a value cursor has to REACH them explicitly or
 * page two ends at the first NULL — and a NULL cursor is the end of the listing, which is why the
 * ascending null case answers `undefined` and `seekSql` drops the whole term rather than emitting
 * SQL that can never be true.
 *
 * `or col is null` only when the column can actually hold one: on a not-null column it is dead SQL
 * the planner has to defeat before it can seek the index, on every paged read.
 */
const seekAfter = (
  column: SqlFragment,
  direction: string,
  bind: SqlFragment | null,
  nullable: boolean,
): SqlFragment | undefined => {
  if (direction === 'desc') {
    return bind === null ? sql`${column} is not null` : sql`${column} < ${bind}`;
  }
  if (bind === null) return undefined;
  return nullable ? sql`(${column} > ${bind} or ${column} is null)` : sql`${column} > ${bind}`;
};

/**
 * At the cursor's position for this key — the prefix a later key's tiebreak hangs off. `= $n` is
 * never true of a NULL in Postgres, so an absent position is `is null`: the same pair
 * `predicateSql` above already emits for `eq`, one page later.
 */
const seekEqual = (column: SqlFragment, bind: SqlFragment | null): SqlFragment =>
  bind === null ? sql`${column} is null` : sql`${column} = ${bind}`;

/**
 * The keyset seek. Two shapes, and which one is legal is decided by the ORDER, never by taste.
 *
 * Every key sorting the same way is a ROW COMPARISON — `(a, b) < ($1, $2)`. That is the shape
 * Postgres can push into a multicolumn index: measured on Postgres 16 over 20,000 rows with an
 * index on `(org, at desc, id desc)`, the row form plans as an Index Only Scan carrying the whole
 * seek as its Index Cond, while the or-chain below plans as a BitmapOr of two index scans plus a
 * Sort over everything they matched.
 *
 * A MIXED order — `published_at desc, id asc` — has no row comparison, so it is spelled out as the
 * or-chain instead. `totalOrder` no longer produces one by accident (the tiebreak follows the last
 * declared key's direction), so this branch is now reached only by a caller who wrote the mixed
 * order themselves.
 *
 * Either way every term is a plain comparison against a bare column, which is what carrying the
 * cursor at the column's own precision bought: the equality class this seek cuts on is exactly the
 * one `orderSql` sorts by, so no row can fall between the two.
 */
/**
 * A row comparison `(a, b) < ($1, $2)` is legal only when the ordering it stands for is the one
 * Postgres gives it — and a row comparison has NO null ordering: a NULL anywhere in either side
 * makes the whole comparison unknown, so under `asc nulls last` every NULL row would be excluded
 * from the very page the ordering puts it on. Uniform direction is therefore not enough; every key
 * has to be a column that cannot hold a NULL.
 */
const rowComparable = <Row>(entity: EntityCore<Row>, orderBy: readonly SortKey[]): boolean => {
  const [first] = orderBy;
  if (first === undefined || orderBy.length < 2) return false;
  return orderBy.every(
    (entry) => entry.direction === first.direction && !isNullableKey(entity, entry.column),
  );
};

const seekSql = <Row>(
  entity: EntityCore<Row>,
  orderBy: readonly SortKey[],
  seek: readonly unknown[],
): SqlFragment => {
  const binds = orderBy.map((entry, index) => seekBind(kindOf(entity, entry.column), seek[index]));
  // One key is already a scalar comparison; `(("id") > ($1))` is the same plan spelled worse.
  if (rowComparable(entity, orderBy)) {
    const columns = join(orderBy.map((entry) => columnRef(entity, entry.column)));
    // Not-null columns, so no bind here can be `null` — but the type says it can, and `sql`null``
    // for one would be a seek from a position no row is after.
    const values = join(binds.map((bind) => bind ?? sql`null`));
    return orderBy[0]?.direction === 'desc'
      ? sql`((${columns}) < (${values}))`
      : sql`((${columns}) > (${values}))`;
  }
  const terms = orderBy.flatMap((entry, index) => {
    const after = seekAfter(
      columnRef(entity, entry.column),
      entry.direction,
      binds[index] ?? null,
      isNullableKey(entity, entry.column),
    );
    // Nothing sorts after a NULL under `nulls last`, so this key's term is dead SQL — dropped
    // rather than emitted. The remaining keys still carry the page: the equality prefix below
    // reaches them as `col is null`.
    if (after === undefined) return [];
    const equal = orderBy
      .slice(0, index)
      .map((earlier, position) =>
        seekEqual(columnRef(entity, earlier.column), binds[position] ?? null),
      );
    return [sql`(${join([...equal, after], ' and ')})`];
  });
  // Every key NULL under an ascending order is the very end of the listing — no row follows it,
  // and `()` is a syntax error.
  return terms.length === 0 ? NEVER : sql`(${join(terms, ' or ')})`;
};

export const conditions = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
): SqlFragment => {
  const parts = plan.where.map((predicate) => predicateSql(entity, predicate));
  if (entity.$softDelete && !shape.includeDeleted) {
    parts.push(sql`${identifier(physicalName(entity, SOFT_DELETE_COLUMN))} is null`);
  }
  if (shape.seek !== undefined) parts.push(seekSql(entity, plan.orderBy, shape.seek));
  return parts.length === 0 ? sql`true` : join(parts, ' and ');
};

/**
 * NULL's place in the ordering, WRITTEN DOWN rather than inherited from the server's default —
 * `asc nulls last`, `desc nulls first`. Identical to `@ultimat3/query`'s `orderTerm`, deliberately:
 * two pagination systems in one framework disagreeing about where a NULL sorts is the ambiguity
 * axiom 1 exists to forbid, and until 2026-08-24 this package refused a nullable sort key outright
 * rather than answer the question. Saying it out loud is also what keeps a driver whose default
 * differs from re-opening the divergence.
 *
 * `raw()` is the same closed set of one word it always was — now four words instead of two, all
 * written here and never derived from a value.
 */
const NULLS_LAST = raw('asc nulls last');
const NULLS_FIRST = raw('desc nulls first');

const orderSql = <Row>(entity: EntityCore<Row>, orderBy: readonly SortKey[]): SqlFragment =>
  join(
    orderBy.map(
      (entry) =>
        sql`${columnRef(entity, entry.column)} ${entry.direction === 'desc' ? NULLS_FIRST : NULLS_LAST}`,
    ),
  );

/**
 * The microsecond half of every `timestamptz` sort key, under an output name no entity can declare
 * (`seekAlias`). Bun's client hands a `timestamptz` back as a JS `Date`, which is milliseconds, so
 * the row itself CANNOT carry the value the `order by` actually sorted by — a cursor minted from
 * it cuts the page at a position no row occupies, and every row inside the boundary millisecond is
 * then served on no page at all.
 *
 * `at time zone 'UTC'` rather than a bare `::text`: the bare cast renders in the session's
 * `TimeZone`, and a page position must not depend on a connection setting.
 */
const seekPrecision = <Row>(entity: EntityCore<Row>, plan: QueryPlan): readonly SqlFragment[] => {
  const seen = new Set<string>();
  return plan.orderBy.flatMap((entry) => {
    if (kindOf(entity, entry.column) !== 'timestamptz') return [];
    const physical = physicalName(entity, entry.column);
    if (seen.has(physical)) return [];
    seen.add(physical);
    return [
      sql`(${identifier(physical)} at time zone 'UTC')::text as ${identifier(seekAlias(physical))}`,
    ];
  });
};

/**
 * A projection always carries the primary key and the sort keys even when the caller did not
 * ask for them: without those values the page cannot produce the cursor that continues it.
 */
const projection = <Row>(entity: EntityCore<Row>, plan: QueryPlan): SqlFragment => {
  const precise = seekPrecision(entity, plan);
  if (plan.select === undefined) {
    return join([...allColumns(entity).map(identifier), ...precise]);
  }
  const wanted = new Set([
    ...plan.select,
    ...entity.$primaryKey,
    ...plan.orderBy.map((entry) => entry.column.split('.')[0] ?? entry.column),
  ]);
  const names = [...wanted].flatMap((property) => {
    const column = columnFor(entity.$columns, property);
    return column === undefined ? [] : columnsOf(property, column);
  });
  return join([...names.map(identifier), ...precise]);
};

export const selectStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  limit: number,
): SqlFragment =>
  sql`select ${projection(entity, plan)} from ${identifier(entity.$table)} where ${conditions(
    entity,
    plan,
    shape,
  )} order by ${orderSql(entity, plan.orderBy)} limit ${limit}`;

export const countStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
): SqlFragment =>
  sql`select count(*) as count from ${identifier(entity.$table)} where ${conditions(entity, plan, shape)}`;

/** What a grouped count comes back as. Both names are fixed, so neither can be a column's. */
export interface GroupRow {
  readonly group_value: unknown;
  readonly group_count: unknown;
}

/**
 * The grouped count: one row per distinct value of one column, over exactly the rows
 * `countStatement` would have counted — the same predicates, the same soft-delete filter, one
 * `group by` more. `limit` bounds the groups, not the rows, which is what turns a whole-table
 * breakdown into a refusal instead of a result set nobody sized.
 *
 * Both output names are aliases and fixed, so they cannot collide with each other whatever the
 * table declares: an entity is free to have a column called `count`, and the un-aliased form would
 * then return two outputs of one name.
 */
export const countByStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  column: string,
  limit: number,
): SqlFragment => {
  const grouped = columnRef(entity, column);
  return sql`select ${grouped} as group_value, count(*) as group_count from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)} group by ${grouped} limit ${limit}`;
};

/**
 * One aggregate over exactly the rows `countStatement` would have counted — the same predicates,
 * the same soft-delete filter, one function more. Four outputs and always the same four names, so
 * neither driver reads a column an entity could also have declared:
 *
 * - `agg_value` — the aggregate itself, as TEXT. `::text` and never a float: `sum(bigint)` is a
 *   `numeric` Bun would hand back as a string anyway, and pinning it makes `integer` behave the
 *   same. `aggregate.ts` re-parses it by the column's kind.
 * - `agg_count` — how many non-null values went in, which is what tells `null` ("no rows") from a
 *   legitimate zero, and what `avg` divides by.
 *
 * `avg` is `round(avg(...), AVG_SCALE)` rather than the server's own scale, because the in-memory
 * driver has to reach the same digits and "whatever numeric division gives you" is not a rule two
 * implementations can share.
 */
export const aggregateStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  fn: AggregateFn,
  column: string,
): SqlFragment => {
  const target = columnRef(entity, column);
  const value =
    fn === 'sum'
      ? sql`sum(${target})`
      : fn === 'avg'
        ? sql`round(avg(${target}), ${AVG_SCALE})`
        : fn === 'min'
          ? sql`min(${target})`
          : sql`max(${target})`;
  return sql`select ${value}::text as agg_value, count(${target}) as agg_count from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)}`;
};

/** What an aggregate comes back as. Both names are fixed, so neither can be a column's. */
export interface AggregateRow {
  readonly agg_value: unknown;
  readonly agg_count: unknown;
}

/**
 * The distinct currencies among the rows an aggregate is about to cover. A separate statement
 * rather than a clever one: `sum(minor)` over two currencies is a number in neither, and the only
 * honest answer is to refuse — which needs the list, not a boolean.
 *
 * Bounded at three, because the refusal names them and a caller with three already knows.
 */
export const currenciesStatement = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  shape: ReadShape,
  currencyColumn: string,
  scaleColumn: string | null,
): SqlFragment => {
  const currency = identifier(currencyColumn);
  // The SCALE is half of what makes two amounts incomparable and it is the half with no symptom:
  // `{ minor: 5, currency: 'USD' }` is five cents and the same row at `scale: 6` is five millionths
  // of a dollar. A table with no scale column has one unit per currency by construction.
  const scale = scaleColumn === null ? sql`null` : identifier(scaleColumn);
  return sql`select distinct ${currency} as group_value, ${scale} as group_scale from ${identifier(
    entity.$table,
  )} where ${conditions(entity, plan, shape)} and ${currency} is not null limit 3`;
};

/** One `(currency, scale)` pair the rows an aggregate covers actually use. */
export interface MoneyUnitRow {
  readonly group_value: unknown;
  readonly group_scale: unknown;
}

/**
 * The planner's own row estimate for a table — `reltuples`, which is what `ANALYZE` last wrote and
 * what every query plan in the database is already costed against. `count(*)` walks every visible
 * row (MVCC gives no shortcut), so on a large table it is the read that exceeds a web role's
 * `statement_timeout`, and no index can make it cheaper: the `fix:` on that timeout tells an author
 * to add one, and following it changes nothing.
 *
 * `to_regclass` rather than a name comparison, so a search_path change cannot silently answer for a
 * different schema's table of the same name — and `-1` is what Postgres 14+ stores for a table that
 * has never been analysed, which is an answer, not an estimate.
 */
export const estimateStatement = (table: string): SqlFragment =>
  sql`select reltuples::bigint as estimate from pg_class where oid = to_regclass(${table})`;
