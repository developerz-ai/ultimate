// Single responsibility: what a batched point read is made of — the scope two lookups must share
// before one statement is allowed to answer both, and the one `select … where <key> in (…)` that
// answers them. The microtask coalescer and the sibling-aware preload both read ids through here,
// so the two can never disagree about when a shared statement is legal.

import { type DbClient, sqlState } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { canonicalDecimal, canonicalInteger } from './numeric-compare';
import { decodeRow, type PhysicalRow } from './pg-row';
import { type ReadShape, selectStatement } from './pg-sql';
import type { QueryPlan } from './tenancy';
import { canonicalUuid } from './uuid-text';

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
 * whether some other lookup shared the microtask; braces and missing hyphens are the same value
 * there too (`uuid-text.ts`). An integer or `numeric` is compared by value too:
 * `'007'` matched the row and missed its answer here, filed under `'7'`. One the column could not
 * hold stays as written, so the statement still carries it and Postgres answers its own refusal.
 * Every other kind compares by its bytes, and lower-casing a text key would merge two rows
 * Postgres keeps apart.
 */
export const keyOf = (kind: string, value: unknown): string => {
  if (kind === 'uuid') return canonicalUuid(value) ?? String(value).toLowerCase();
  if (kind === 'integer' || kind === 'bigint') return canonicalInteger(value) ?? String(value);
  if (kind === 'numeric') return canonicalDecimal(value) ?? String(value);
  if (kind === 'timestamptz') return canonicalInstant(value) ?? String(value);
  return String(value);
};

/**
 * An instant as ISO 8601 in UTC — a `Date` and its ISO text are one key. `String(date)` was the
 * process time zone's spelling: a partitioned table's key held a different id per server, and a
 * search index's id could not be read back into the value it named.
 */
const canonicalInstant = (value: unknown): string | undefined => {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};

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
const readStatement = async <Row>(
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

/** `in_failed_transaction`: a statement sent after the first refusal aborted the transaction. */
const IN_FAILED_TRANSACTION = '25P02';

/** SQLSTATE class 22, data exception: the server refused a VALUE, not the statement's shape. */
const isDataError = (error: unknown): boolean => sqlState(error)?.startsWith('22') === true;

/**
 * `readStatement`, with a value the server refuses failing only the id that carried it. One key
 * the column cannot hold (`'abc'` against a `bigint`) is a class 22 refusal of the WHOLE statement,
 * so every lookup widened into it was failed by an id it never asked for — rows the single
 * statement each would have sent answers. The ids are re-sent in halves until the refused one
 * stands alone: about `2k·log2(n)` statements for `k` bad ids, never one per id.
 *
 * Anything else — a dropped connection, a timeout, a stale schema — is the statement's own failure
 * and is rethrown for every caller, as before; a half that fails that way answers its ids with its
 * own failure. Only a half sent into a transaction the first refusal aborted (`25P02`) gets the
 * FIRST refusal, the one the unsplit statement gave them.
 */
export const readByIds = async <Row>(
  read: PointRead<Row>,
  ids: readonly unknown[],
): Promise<ReadonlyMap<string, Answer>> => {
  try {
    return await readStatement(read, ids);
  } catch (error) {
    if (!isDataError(error) || ids.length < 2) throw error;
    const answers = new Map<string, Answer>();
    await isolate(read, ids, error, answers);
    return answers;
  }
};

/** `ids` is known to fail together with `refusal`: halve, and file what each half answers. */
const isolate = async <Row>(
  read: PointRead<Row>,
  ids: readonly unknown[],
  refusal: unknown,
  answers: Map<string, Answer>,
): Promise<void> => {
  const middle = Math.ceil(ids.length / 2);
  for (const half of [ids.slice(0, middle), ids.slice(middle)]) {
    try {
      for (const [key, answer] of await readStatement(read, half)) answers.set(key, answer);
    } catch (error) {
      if (isDataError(error) && half.length > 1) {
        await isolate(read, half, error, answers);
        continue;
      }
      // Only a transaction the first refusal ABORTED inherits it; a half's own failure (a pool
      // timeout, a failover's 57P01) is that half's answer, never "invalid input syntax".
      const own = sqlState(error) === IN_FAILED_TRANSACTION ? refusal : error;
      for (const id of half) answers.set(keyOf(read.key.kind, id), { error: own });
    }
  }
};

/** One statement's worth at a time — a batch too wide for the bind count is several, never one. */
export const statementChunks = <T>(values: readonly T[]): readonly (readonly T[])[] => {
  const chunks: T[][] = [];
  for (let from = 0; from < values.length; from += MAX_IDS_PER_STATEMENT) {
    chunks.push(values.slice(from, from + MAX_IDS_PER_STATEMENT));
  }
  return chunks;
};
