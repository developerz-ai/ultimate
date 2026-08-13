// Single responsibility: what a batched point read is made of — the scope two lookups must share
// before one statement is allowed to answer both, and the one `select … where <key> in (…)` that
// answers them. The microtask coalescer and the sibling-aware preload both read ids through here,
// so the two can never disagree about when a shared statement is legal.

import type { DbClient } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { decodeRow, type PhysicalRow } from './pg-row';
import { type ReadShape, selectStatement } from './pg-sql';
import type { QueryPlan } from './tenancy';

/**
 * Postgres binds at most 65535 parameters, so a batch wider than this becomes several statements
 * rather than one the driver refuses. Splitting can only cost round trips; not splitting would
 * fail reads that succeeded one at a time, and a batcher that breaks a working program is worse
 * than no batcher.
 */
export const MAX_IDS_PER_STATEMENT = 500;

/** The primary key, in the three spellings a batch needs: the plan's, the table's, and the type. */
export interface KeyColumn {
  readonly property: string;
  readonly column: string;
  readonly kind: string;
}

/**
 * One row, or the failure decoding it. A column the table no longer matches is that row's
 * problem: a caller whose own row decoded must still be handed it, exactly as it would have been
 * by the statement it did not share.
 */
export type Answer = { readonly row: unknown } | { readonly error: unknown };

/**
 * The string both sides of a batch are filed under — the requested id, and the key of a row that
 * came back. Postgres compares a `uuid` as a value and prints it lower-cased, so an id handed in
 * upper case matches the row *there* and would miss it here, which would make an answer depend on
 * whether some other lookup shared the microtask. Every other kind compares by its bytes, and
 * lower-casing a text key would merge two rows Postgres keeps apart.
 */
export const keyOf = (kind: string, value: unknown): string =>
  kind === 'uuid' ? String(value).toLowerCase() : String(value);

/** A scope value has to be comparable as a string, or two scopes cannot be told apart. */
const scopeValue = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return `date:${value.getTime()}`;
  const kind = typeof value;
  return kind === 'string' || kind === 'number' || kind === 'bigint' || kind === 'boolean'
    ? `${kind}:${String(value)}`
    : undefined;
};

/**
 * Everything about the read except the id. Two lookups may share one statement only when this
 * matches: another tenant's predicate, a different projection or a different soft-delete
 * visibility is a different query, and merging them would answer a caller with rows the statement
 * they asked for could never have returned.
 *
 * `undefined` when a predicate value cannot be rendered — an object scope is one this cannot prove
 * two lookups share, and a batch is only ever an optimisation, so it declines instead of guessing.
 */
export const scopeKey = <Row>(
  entity: EntityCore<Row>,
  scoped: QueryPlan,
  shape: ReadShape,
): string | undefined => {
  const predicates: string[][] = [];
  for (const predicate of scoped.where) {
    const value = scopeValue(predicate.value);
    if (value === undefined) return undefined;
    predicates.push([predicate.column, predicate.op, value]);
  }
  // JSON rather than a joined string: a value carrying the separator cannot forge a boundary.
  return JSON.stringify([
    entity.$name,
    entity.$table,
    shape.includeDeleted,
    scoped.select ?? null,
    predicates,
  ]);
};

/**
 * One read, minus the ids. This is the whole of what a shared statement is allowed to vary in —
 * a batch that widens anything else here is a batch answering a caller with rows their own
 * statement could never have returned.
 */
export interface PointRead<Row> {
  readonly entity: EntityCore<Row>;
  /** A pinned client and the ambient pool are two places to read from, never one batch. */
  readonly client: DbClient;
  /** The plan with the id predicate removed — the scope every id in the batch shares. */
  readonly scoped: QueryPlan;
  readonly shape: ReadShape;
  readonly key: KeyColumn;
}

/** The one statement, filed by key — the same builder, the same scope, `in` instead of `=`. */
export const readByIds = async <Row>(
  read: PointRead<Row>,
  ids: readonly unknown[],
): Promise<ReadonlyMap<string, Answer>> => {
  const { entity, scoped, key } = read;
  const found = await read.client.query<PhysicalRow>(
    selectStatement(
      entity,
      { ...scoped, where: [{ column: key.property, op: 'in', value: ids }, ...scoped.where] },
      read.shape,
      ids.length,
    ),
  );
  const answers = new Map<string, Answer>();
  for (const physical of found) {
    // Filed under the value the statement matched on, which is readable whether or not the rest
    // of the row decodes — so a drifted column fails one caller instead of everyone in the batch.
    const filedAt = keyOf(key.kind, physical[key.column]);
    try {
      answers.set(filedAt, { row: decodeRow(entity, physical) });
    } catch (error) {
      answers.set(filedAt, { error });
    }
  }
  return answers;
};

/** One statement's worth at a time — a batch too wide for the bind count is several, never one. */
export const statementChunks = <T>(values: readonly T[]): readonly (readonly T[])[] => {
  const chunks: T[][] = [];
  for (let from = 0; from < values.length; from += MAX_IDS_PER_STATEMENT) {
    chunks.push(values.slice(from, from + MAX_IDS_PER_STATEMENT));
  }
  return chunks;
};
