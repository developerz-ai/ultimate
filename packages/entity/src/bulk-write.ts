// Single responsibility: what a many-row write is made of, decided once in PROPERTY space so both
// drivers write the same thing — the columns one statement carries, which of them a collision
// overwrites, and the chunking that keeps a statement inside Postgres's bind count. The SQL is
// `pg-sql.ts`'s; everything here is the decision that has to precede it, and the in-memory driver
// reads the same answer rather than a second copy of the rule.

import { keyOf } from './batch-read';
import { columnFor } from './column';
import { valueAt } from './cursor';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { EntityError, invariantViolated } from './errors';
import { columnsOf } from './pg-row';
import type { RowPatch } from './types';

/**
 * Postgres binds at most 65535 parameters in one statement and a multi-row insert spends
 * rows × columns of them, so a wide batch becomes several statements rather than one the server
 * refuses — the same rule `MAX_IDS_PER_STATEMENT` (`batch-read.ts`) applies to a batched read.
 */
export const MAX_BIND_PARAMETERS = 65535;

/** What an `upsertAll` resolves to. Property names, so the two drivers read one answer. */
export interface UpsertPlan {
  /** The unique constraint a collision is judged against. */
  readonly on: readonly string[];
  /** What a colliding row takes from the incoming one. Empty leaves the stored row alone. */
  readonly set: readonly string[];
}

const owns = (row: unknown, property: string): boolean =>
  typeof row === 'object' && row !== null && Object.hasOwn(row, property);

/**
 * The properties a batch writes: every declared column at least one row names, in declaration
 * order. `Object.hasOwn` decides it, exactly as `bindValues` does — a property present and
 * `undefined` is a value the caller wrote, and dropping it here would insert a column the update
 * set then skipped.
 */
export const namedProperties = <Row>(
  entity: EntityCore<Row>,
  rows: readonly RowPatch<Row>[],
): readonly string[] =>
  Object.keys(entity.$columns).filter((property) => rows.some((row) => owns(row, property)));

/** Those properties as physical columns. Money is two columns, so this is not the same list. */
export const insertColumns = <Row>(
  entity: EntityCore<Row>,
  properties: readonly string[],
): readonly string[] =>
  properties.flatMap((property) => {
    const column = columnFor(entity.$columns, property);
    return column === undefined ? [] : columnsOf(property, column);
  });

/**
 * Rows per statement: the bind budget divided by one row's width, never fewer than one. Splitting
 * can only cost round trips; not splitting would fail a write that succeeded one row at a time.
 */
export const insertChunks = <T>(rows: readonly T[], width: number): readonly (readonly T[])[] => {
  if (rows.length === 0) return [];
  const size = width <= 0 ? rows.length : Math.max(1, Math.floor(MAX_BIND_PARAMETERS / width));
  const chunks: (readonly T[])[] = [];
  for (let from = 0; from < rows.length; from += size) chunks.push(rows.slice(from, from + size));
  return chunks;
};

/**
 * Not `invariantViolated`: its fix opens `x entity explain`, which describes invariants nobody
 * wrote here. What repairs each of these is one edit to the call.
 */
const noConflictTarget = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.upsertAll() named no onConflict columns — a collision is judged against a unique constraint, never against "any"`,
    fix: `${entityName}.upsertAll(rows, { onConflict: ['<column>'] })   # the columns of the unique index a duplicate lands on`,
  });

const nothingToSet = (
  entityName: string,
  on: readonly string[],
  spared: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.upsertAll() would write nothing on a collision: every column in the batch is one a collision never moves (${spared.join(', ')})`,
    fix: `${entityName}.upsertAll(rows, { onConflict: ['${on.join("', '")}'], onMatch: 'nothing' })   # keep the stored row`,
  });

const collidesWithItself = (
  entityName: string,
  on: readonly string[],
  position: number,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.upsertAll() row ${position + 1} repeats a value of (${on.join(', ')}) already in the batch — one statement cannot update the same row twice`,
    fix: `${entityName}.upsertAll(rows, { onConflict: ['${on.join("', '")}'], onMatch: 'nothing' })   # or dedupe rows on (${on.join(', ')}) before the call`,
  });

const noSuchConstraint = (
  entityName: string,
  on: readonly string[],
  declared: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName} declares no unique constraint on (${on.join(', ')}); Postgres answers a conflict target it cannot match with 42P10${declared.length === 0 ? '' : ` — it has ${declared.join('; ')}`}`,
    fix: `indexes: [{ on: ['${on.join("', '")}'], unique: true }]   # in the ${entityName} entity(), then x db gen "unique ${on.join(' ')}"`,
  });

const unevenBatch = (entityName: string, position: number, missing: string): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.upsertAll() row ${position + 1} does not name "${missing}", which other rows of the batch do — under onMatch: 'update' a column one row omits would be overwritten with that column's default, not left alone`,
    fix: `${entityName}.upsertAll(rows.map((row) => ({ ...row, ${missing}: <value> })), args)   # every row of an updating batch names the same columns`,
  });

/**
 * A cross-tenant upsert is not a batching mistake, it is a write into another tenant's row, so it
 * gets tenancy's own code. `X_TENANCY_UNSCOPED`'s own factory sends the reader to the request
 * context the tenant is derived from, which is not what repairs this: an upsert builds no read
 * plan, so nothing derives anything onto it — the scope has to be part of the constraint the
 * collision is judged against, or the row that comes back was never in scope to begin with.
 */
const crossTenantUpsert = (
  entityName: string,
  tenant: string,
  on: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_TENANCY_UNSCOPED',
    cause: `${entityName}.upsertAll() resolves a collision on (${on.join(', ')}), which does not include the tenant column "${tenant}" — a row stored by another tenant would match and be overwritten`,
    fix: `${entityName}.upsertAll(rows, { onConflict: ['${tenant}', '${on.join("', '")}'] })   # or onMatch: 'nothing', which writes nothing to a row it does not own`,
  });

/**
 * Every conflict target Postgres could infer an index for. Three sources, because this framework
 * has three ways to declare one unique index and a target refused for being declared the "wrong"
 * way would send its author to add a SECOND declaration of a constraint they already wrote:
 * the primary key, `unique()`/`indexes: [{ unique: true }]` (both land in `$indexes`), and
 * `invariant(name, c.unique([…]))`, which emits its `create unique index` out of `$invariants`.
 *
 * A partial unique index is excluded from all three: its predicate would have to be repeated in
 * the `on conflict` clause, which this layer does not spell. `bindInvariant` stamps that `where`
 * on a soft-deleting entity, so the same one rule covers both lists.
 */
const uniqueTargets = <Row>(entity: EntityCore<Row>): readonly (readonly string[])[] => [
  insertColumns(entity, entity.$primaryKey),
  ...entity.$indexes.filter((i) => i.unique && i.where === undefined).map((i) => i.columns),
  ...entity.$invariants
    .filter((i) => i.kind === 'unique' && i.where === undefined)
    .map((i) => i.columns),
];

const sameColumns = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

/**
 * The conflict target, and what a collision overwrites. `'nothing'` overwrites nothing by
 * definition; `'update'` takes every column the batch writes except three closed sets — the
 * conflict target, which is how the stored row was found, the primary key, which is its address,
 * and the soft-delete stamp, which is whether the row is there at all. An upsert that moved one of
 * the first two would move a row nobody asked to move, and every foreign key already pointing at
 * that id would miss it.
 *
 * The stamp is the third for a reason no caller can work around: a soft-deleted row still occupies
 * its conflict target — the unique index it collides with is not partial — so setting `deleted_at`
 * from `excluded` would clear a stamp the app wrote and hand the row back holding this batch's
 * values. That is the resurrection `update(id, patch)` and `updateWhere` both refuse by carrying
 * `deleted_at is null`, which an `on conflict` clause cannot carry. Excluded rather than refused,
 * because `$parse` fills every declared column before a row reaches here: the `deletedAt: null` in
 * the batch is the framework's, not the caller's, and refusing it would make `'update'` impossible
 * on every soft-deleting entity. `insertAll` is untouched — a row with no stored row to collide
 * with writes the stamp it carries, exactly as `insert` does.
 *
 * Four refusals precede all of that, and each one is a statement Postgres would either reject or,
 * worse, accept: a target no declared unique constraint matches (`42P10`), a target that does not
 * carry the tenant column under `'update'` (another tenant's row, silently rewritten), a batch
 * whose rows name different columns under `'update'` (`excluded.<col>` is the column's default for
 * a row that omitted it, so "leave it alone" is not what happens), and a target that leaves
 * nothing to write.
 */
export const upsertPlan = <Row>(
  entity: EntityCore<Row>,
  rows: readonly RowPatch<Row>[],
  onConflict: readonly string[],
  onMatch: 'update' | 'nothing',
): UpsertPlan => {
  if (onConflict.length === 0) throw noConflictTarget(entity.$name);
  for (const property of onConflict) {
    if (columnFor(entity.$columns, property) === undefined) {
      throw invariantViolated(
        entity.$name,
        'upsertAll',
        `no column "${property}" — pick from: ${Object.keys(entity.$columns).join(', ')}`,
      );
    }
  }
  const targets = uniqueTargets(entity);
  const physical = insertColumns(entity, onConflict);
  if (!targets.some((target) => sameColumns(target, physical))) {
    throw noSuchConstraint(
      entity.$name,
      onConflict,
      targets.map((target) => `(${target.join(', ')})`),
    );
  }
  if (onMatch === 'nothing') return { on: onConflict, set: [] };
  const tenant = entity.$tenantColumn;
  if (tenant !== null && !onConflict.includes(tenant)) {
    throw crossTenantUpsert(entity.$name, tenant, onConflict);
  }
  const properties = namedProperties(entity, rows);
  for (const [position, row] of rows.entries()) {
    const missing = properties.find((property) => !owns(row, property));
    if (missing !== undefined) throw unevenBatch(entity.$name, position, missing);
  }
  const spared = new Set([
    ...onConflict,
    ...entity.$primaryKey,
    ...(entity.$softDelete ? [SOFT_DELETE_COLUMN] : []),
  ]);
  const set = properties.filter((property) => !spared.has(property));
  // An empty batch sends no statement, so there is nothing to refuse — but the target above is
  // checked either way, so a typo in `onConflict` fails on no rows exactly as it does on a page.
  if (set.length === 0 && properties.length > 0) {
    throw nothingToSet(entity.$name, onConflict, [...spared]);
  }
  return { on: onConflict, set };
};

/**
 * One cell of a conflict target. `keyOf` alone is `batch-read.ts`'s spelling of an *id*, and three
 * kinds need more than it: a `Date` stringifies without its milliseconds, an object (money is one)
 * stringifies to `[object Object]`, and — the one that changes an answer — a null is not a value
 * Postgres compares. A default unique index is `NULLS DISTINCT`, so two rows with a null in the
 * target collide with nothing, not with each other.
 */
const cellKey = (kind: string, value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (typeof value === 'object') {
    return `json:${JSON.stringify(value, (_, part) => (typeof part === 'bigint' ? `${part}n` : part))}`;
  }
  return `value:${keyOf(kind, value)}`;
};

/**
 * One row's conflict target as a string, spelled the way a batched read spells a key — a `uuid`
 * handed in upper case is the value Postgres matches, so it must be the value matched here.
 * `undefined` when any cell is null: that row's target is distinct from every other, as it is in
 * the index, so it collides with nothing.
 */
export const conflictKeyOf = <Row>(
  entity: EntityCore<Row>,
  on: readonly string[],
  row: RowPatch<Row>,
): string | undefined => {
  const cells = on.map((property) =>
    cellKey(columnFor(entity.$columns, property)?.$meta.kind ?? '', valueAt(row, property)),
  );
  return cells.some((cell) => cell === undefined) ? undefined : JSON.stringify(cells);
};

/**
 * Every row's conflict key, refusing a batch that collides with itself. Postgres answers two rows
 * with one conflict target under `do update` with `ON CONFLICT DO UPDATE command cannot affect row
 * a second time`, so it is refused here — in both drivers — rather than passing in memory and
 * failing in production. Under `do nothing` the server skips the repeat, and so does the memory
 * driver, which is why this only guards the update form.
 */
export const conflictKeys = <Row>(
  entity: EntityCore<Row>,
  plan: UpsertPlan,
  rows: readonly RowPatch<Row>[],
): readonly (string | undefined)[] => {
  const keys = rows.map((row) => conflictKeyOf(entity, plan.on, row));
  if (plan.set.length === 0) return keys;
  const seen = new Set<string>();
  for (const [position, key] of keys.entries()) {
    // A null in the target is no key at all, so it repeats nothing — `NULLS DISTINCT` again.
    if (key === undefined) continue;
    if (seen.has(key)) throw collidesWithItself(entity.$name, plan.on, position);
    seen.add(key);
  }
  return keys;
};
