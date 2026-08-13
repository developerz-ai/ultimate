// Single responsibility: collapse the point lookups one request issues in the same microtask into
// a single `where id in (…)`. A list that resolves an author per row is the N+1 this removes, and
// it removes it without adding a second way to read — `findById` keeps its signature and its
// meaning, and pays for one round trip instead of one per row.

import { type Ctx, tryUseContext } from '@ultimat3/core';
import type { DbClient } from '@ultimat3/db';
import type { EntityCore } from './entity';
import { decodeRow, type PhysicalRow, physicalName } from './pg-row';
import { type ReadShape, selectStatement } from './pg-sql';
import type { QueryPlan } from './tenancy';

/**
 * Postgres binds at most 65535 parameters, so a batch wider than this becomes several statements
 * rather than one the driver refuses. Splitting can only cost round trips; not splitting would
 * fail reads that succeeded one at a time, and a coalescer that breaks a working program is worse
 * than no coalescer.
 */
export const MAX_IDS_PER_STATEMENT = 500;

/** The primary key, in the three spellings a batch needs: the plan's, the table's, and the type. */
interface KeyColumn {
  readonly property: string;
  readonly column: string;
  readonly kind: string;
}

/**
 * One row, or the failure decoding it. A column the table no longer matches is that row's
 * problem: a caller whose own row decoded must still be handed it, exactly as it would have been
 * by the statement it did not share.
 */
type Answer = { readonly row: unknown } | { readonly error: unknown };

/** One caller's lookup: the row it asked for, and the two ends of the promise it is holding. */
interface Pending {
  readonly id: unknown;
  /** What the answer will be filed under — `keyOf(id)`, not the id itself. */
  readonly key: string;
  readonly row: Promise<unknown>;
  readonly settle: (row: unknown) => void;
  readonly fail: (error: unknown) => void;
}

/** One statement in the making: the ids collected so far, and the read that will send them. */
interface Batch {
  /** Two lookups share a statement only when they read from the same place. */
  readonly client: DbClient;
  /** Keyed by `String(id)`, so the same id asked for twice is one bind and one row. */
  readonly pending: Map<string, Pending>;
  readonly load: (ids: readonly unknown[]) => Promise<ReadonlyMap<string, Answer>>;
}

/**
 * The string both sides of a batch are filed under — the requested id, and the key of a row that
 * came back. Postgres compares a `uuid` as a value and prints it lower-cased, so an id handed in
 * upper case matches the row *there* and would miss it here, which would make an answer depend on
 * whether some other lookup shared the microtask. Every other kind compares by its bytes, and
 * lower-casing a text key would merge two rows Postgres keeps apart.
 */
const keyOf = (kind: string, value: unknown): string =>
  kind === 'uuid' ? String(value).toLowerCase() : String(value);

/**
 * Per request, keyed by ctx identity, so a batch dies with the request that opened it — the shape
 * `@ultimat3/query`'s request memo has one tier up. `entity` cannot import that one (tier 2 to
 * tier 3 is upward), so it owns this one.
 */
const requests = new WeakMap<object, Map<string, Batch>>();

const batchesFor = (ctx: Ctx): Map<string, Batch> => {
  const key: object = ctx;
  const existing = requests.get(key);
  if (existing !== undefined) return existing;
  const created = new Map<string, Batch>();
  requests.set(key, created);
  return created;
};

const pendingFor = (id: unknown, key: string): Pending => {
  // The executor runs synchronously, so both are assigned before this returns. TypeScript cannot
  // see through the callback, which is all the definite assignments claim.
  let settle!: (row: unknown) => void;
  let fail!: (error: unknown) => void;
  const row = new Promise<unknown>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { id, key, row, settle, fail };
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
const scopeKey = <Row>(
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

/** The one statement, filed by key — the same builder, the same scope, `in` instead of `=`. */
const readByIds = async <Row>(
  entity: EntityCore<Row>,
  client: DbClient,
  scoped: QueryPlan,
  shape: ReadShape,
  key: KeyColumn,
  ids: readonly unknown[],
): Promise<ReadonlyMap<string, Answer>> => {
  const found = await client.query<PhysicalRow>(
    selectStatement(
      entity,
      { ...scoped, where: [{ column: key.property, op: 'in', value: ids }, ...scoped.where] },
      shape,
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

const openBatch = (
  batches: Map<string, Batch>,
  key: string,
  client: DbClient,
  load: Batch['load'],
): Batch => {
  const batch: Batch = { client, pending: new Map(), load };
  batches.set(key, batch);
  // The window is one microtask: every lookup issued before the current synchronous run ends
  // shares this statement. It closes here, before the statement is sent, so a lookup arriving
  // mid-flight opens the next batch instead of joining ids already on the wire.
  queueMicrotask(() => {
    if (batches.get(key) === batch) batches.delete(key);
    void flush(batch);
  });
  return batch;
};

const flush = async (batch: Batch): Promise<void> => {
  const waiting = [...batch.pending.values()];
  batch.pending.clear();
  // One statement at a time: a batch wide enough to split must not take the pool with it.
  for (let from = 0; from < waiting.length; from += MAX_IDS_PER_STATEMENT) {
    const chunk = waiting.slice(from, from + MAX_IDS_PER_STATEMENT);
    try {
      const answers = await batch.load(chunk.map((entry) => entry.id));
      for (const entry of chunk) {
        const answer = answers.get(entry.key);
        // An id the statement did not answer for is a row that is not there — `findById`'s `null`,
        // never a rejection, and never another caller's row.
        if (answer === undefined) entry.settle(null);
        else if ('error' in answer) entry.fail(answer.error);
        else entry.settle(answer.row);
      }
    } catch (error) {
      // The statement failed, so everyone in it gets the failure the single statement would have
      // handed them. Every one of these promises was returned to a caller, so none goes unhandled.
      for (const entry of chunk) entry.fail(error);
    }
  }
};

/**
 * The batch this lookup joins, or `undefined` when there is none to join: no request in scope, a
 * composite key, a scope this cannot compare, or a client the open batch does not read from.
 * Declining is always correct — the caller sends the one statement it always sent.
 */
export const coalesceFindById = <Row>(
  entity: EntityCore<Row>,
  client: DbClient,
  plan: QueryPlan,
  shape: ReadShape,
  id: unknown,
): Promise<Row | null> | undefined => {
  const ctx = tryUseContext();
  const [keyColumn] = entity.$primaryKey;
  const declared = keyColumn === undefined ? undefined : entity.$columns[keyColumn];
  if (
    ctx === undefined ||
    keyColumn === undefined ||
    declared === undefined ||
    entity.$primaryKey.length !== 1
  ) {
    return undefined;
  }
  // A seek positions a page, never a point lookup. If one ever reaches here the statement is not
  // the one this batches.
  if (shape.seek !== undefined) return undefined;
  const at = plan.where.findIndex(
    (predicate) =>
      predicate.column === keyColumn && predicate.op === 'eq' && predicate.value === id,
  );
  if (at === -1) return undefined;
  const scoped: QueryPlan = { ...plan, where: plan.where.filter((_, index) => index !== at) };
  const key = scopeKey(entity, scoped, shape);
  if (key === undefined) return undefined;

  const batches = batchesFor(ctx);
  const open = batches.get(key);
  // A pinned client and the ambient pool are two places to read from, and a batch is one
  // statement: a lookup that does not share the open batch's client sends its own.
  if (open !== undefined && open.client !== client) return undefined;
  const keyColumnRef: KeyColumn = {
    property: keyColumn,
    column: physicalName(entity, keyColumn),
    kind: declared.$meta.kind,
  };
  const batch =
    open ??
    openBatch(batches, key, client, (ids) =>
      readByIds(entity, client, scoped, shape, keyColumnRef, ids),
    );

  const filedAt = keyOf(keyColumnRef.kind, id);
  const already = batch.pending.get(filedAt);
  const pending = already ?? pendingFor(id, filedAt);
  if (already === undefined) batch.pending.set(filedAt, pending);
  // One batch is one entity — the key fixed that before the batch existed — so this re-attaches
  // the row type the store erased rather than asserting anything new about it.
  return pending.row as Promise<Row | null>;
};
