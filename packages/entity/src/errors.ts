// The entity layer's stable error codes. Each factory produces the exact command
// that fixes the situation — `X_DB_DRIFT` is the flagship: it names the table, the
// column and the generator invocation.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const ENTITY_OWNED_ERROR_CODES = [
  'X_ENTITY_DUPLICATE',
  'X_INVARIANT_VIOLATED',
  'X_TENANCY_UNSCOPED',
  'X_NOT_FOUND',
  'X_WRITE_UNFILTERED',
  'X_PATCH_EMPTY',
  'X_PRELOAD_UNKNOWN_RELATION',
  'X_N_PLUS_ONE_QUERY',
  'X_N_PLUS_ONE_WRITE',
] as const;

/**
 * `X_DB_DRIFT` is `@ultimat3/db`'s — drift is a fact about migrations, and this package imports db
 * rather than the other way round. `dbDrift()` below throws it; nothing here titles it, because a
 * second copy of the title is what lets the two packages disagree about what the code means.
 */
export const ENTITY_BORROWED_ERROR_CODES = ['X_DB_DRIFT'] as const;

/** Every code entity can throw: the ones it owns plus the one it borrows. */
export const ENTITY_ERROR_CODES = [
  ...ENTITY_OWNED_ERROR_CODES,
  ...ENTITY_BORROWED_ERROR_CODES,
] as const;

export type EntityOwnedErrorCode = (typeof ENTITY_OWNED_ERROR_CODES)[number];
export type EntityErrorCode = (typeof ENTITY_ERROR_CODES)[number];

export const ENTITY_ERROR_TITLES: Readonly<Record<EntityOwnedErrorCode, string>> = {
  X_ENTITY_DUPLICATE: 'two entities claim the same name',
  X_INVARIANT_VIOLATED: 'a domain invariant rejected this row',
  X_TENANCY_UNSCOPED: 'a tenant-scoped query has no org predicate',
  X_NOT_FOUND: 'no row for that id',
  X_WRITE_UNFILTERED: 'a filtered write named no filter columns',
  X_PATCH_EMPTY: 'a filtered update named no columns to write',
  X_PRELOAD_UNKNOWN_RELATION: 'no relation of that name on this entity',
  X_N_PLUS_ONE_QUERY: 'a read repeated once per row',
  X_N_PLUS_ONE_WRITE: 'a write repeated once per row',
};

// Registered at module load, unconditionally, in one call. Without this the registry humanises the
// code and every surface renders a title this package never wrote; with a presence guard, a second
// package claiming one of these codes would silently win instead of throwing X_ERROR_CODE_DUPLICATE.
registerErrorCodes(
  Object.fromEntries(Object.entries(ENTITY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class EntityError extends UltimateError {
  override readonly name = 'EntityError';

  constructor(init: { code: EntityErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

export const entityDuplicate = (name: string, existingTable: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_DUPLICATE',
    cause: `entity "${name}" is already registered for table "${existingTable}"`,
    fix: `x entities list --json   # then rename one of the two entity({ name }) declarations`,
  });

export const invariantViolated = (
  entityName: string,
  invariantName: string,
  message: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${invariantName}: ${message}`,
    fix: `x entity explain ${entityName} --json   # shows the invariant and its SQL CHECK`,
  });

export const tenancyUnscoped = (entityName: string, operation: string): EntityError =>
  new EntityError({
    code: 'X_TENANCY_UNSCOPED',
    cause: `${entityName}.${operation}() was built without an org predicate but the entity has an orgId column`,
    fix: `pass { orgId } to ${entityName}.${operation}(), or wrap the plan with orgScoped(entity, orgId, plan)`,
  });

export const dbDrift = (tableName: string, columnName: string): EntityError =>
  new EntityError({
    code: 'X_DB_DRIFT',
    cause: `table "${tableName}" has column "${columnName}" not present in any migration`,
    fix: `x db gen "add ${columnName}"`,
  });

export const notFound = (entityName: string, id: string): EntityError =>
  new EntityError({
    code: 'X_NOT_FOUND',
    cause: `${entityName} ${id} does not exist (or is soft-deleted)`,
    fix: `x db query "select id from ${entityName} limit 5" --json   # confirm the id you expect`,
  });

/**
 * A filtered write with no filter is refused rather than read as "every row": an empty filter is
 * what a forgotten variable produces, and the two intentions look identical at the call site.
 *
 * One code for `deleteWhere` and `updateWhere`, not one each. The situation is a single one — a
 * filtered write that named no filter — and the remedy is a single edit; splitting it by verb
 * would give two codes the same `fix` and make a caller decide which to catch.
 */
export const writeUnfiltered = (
  entityName: string,
  operation: string,
  primaryKey: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_WRITE_UNFILTERED',
    cause: `${entityName}.${operation}() named no filter columns — an empty filter would reach every row`,
    fix: `${entityName}.${operation}({ ${primaryKey.join(', ')} }, …)   # name the columns that bound it. A deliberate whole-table write is a migration: x db gen "<name>"`,
  });

/**
 * An empty patch is refused for the same reason an empty filter is, and it is the same mistake one
 * argument along: `updateWhere(filter, { lastReadAt })` on a variable that came back undefined
 * reduces to `{}`. Reporting "n rows updated" for a statement that wrote nothing is exactly the
 * silent no-op the count was added to make impossible.
 */
/**
 * The declared names go in the `fix` because there is nowhere to go and read them: a relation is
 * derived from a `references()` column, never declared, so a schema file lists foreign keys and
 * not relation names. The first one is spelled as a call the reader can paste — a name alone
 * still leaves them writing the expression — and the rest follow it.
 *
 * An entity with no foreign key at all is the other mistake, and the declaration it needs names an
 * entity this error cannot know. So it leads with the command that lists the ones to pick from
 * rather than with a placeholder nobody can resolve.
 */
export const preloadUnknownRelation = (
  entityName: string,
  relation: string,
  declared: readonly string[],
): EntityError => {
  const [first, ...rest] = declared;
  return new EntityError({
    code: 'X_PRELOAD_UNKNOWN_RELATION',
    cause: `${entityName} has no relation named "${relation}"`,
    fix:
      first === undefined
        ? `x entities list --json   # then add .references(() => <target>.id) to the ${entityName} column that points at one`
        : `relationNamed('${entityName}', '${first}')` +
          (rest.length === 0 ? '' : `   # or: ${rest.join(', ')}`),
  });
};

export const patchEmpty = (
  entityName: string,
  operation: string,
  columns: readonly string[],
): EntityError =>
  new EntityError({
    code: 'X_PATCH_EMPTY',
    cause: `${entityName}.${operation}() named no columns to write`,
    fix: `${entityName}.${operation}(filter, { <column>: <value> })   # pick a column from: ${columns.join(', ')}`,
  });

/**
 * One chain that would have read the loop's rows with the page that caused it. `from` is the entity
 * being paged and `relation` its own name for the edge — both derived from a `references()` column,
 * never invented here, so the fix is a call that already resolves.
 */
export interface PreloadCandidate {
  readonly from: string;
  readonly relation: string;
}

/**
 * How the repeated read is read once instead, in the order the fix prefers. A relation the schema
 * declared gives the exact `preload()` call; an entity with no such relation still has the `in`
 * form of the statement it was already sending; a statement no repository sent has neither — there
 * is no chain to name, and the batched form of hand-written SQL is the author's own.
 */
export type QueryLoopBatch =
  | {
      readonly form: 'preload';
      /** Non-empty by construction: a `preload` fix with nothing to name is an empty fix line. */
      readonly candidates: readonly [PreloadCandidate, ...PreloadCandidate[]];
    }
  | { readonly form: 'in'; readonly entity: string }
  | { readonly form: 'sql' };

/** The same three-way choice for a loop that writes: the entity's bulk call, or hand-written SQL. */
export type WriteLoopBatch =
  | { readonly form: 'bulk'; readonly entity: string; readonly op: string | undefined }
  | { readonly form: 'sql' };

/**
 * The first candidate is spelled as a call to paste and the rest follow it, exactly as
 * `preloadUnknownRelation` spells its names: one loop can be answered from more than one page —
 * two entities may both reference the one being looked up — and the diagnostic saw the repeated
 * statement, never the `for … of` above it, so it names them all rather than guessing which page
 * this request was iterating.
 */
const preloadCalls = (candidates: readonly [PreloadCandidate, ...PreloadCandidate[]]): string => {
  const [first, ...rest] = candidates.map(
    ({ from, relation }) => `db.${from}.preload('${relation}')`,
  );
  return `${first}   # one statement for the whole page${rest.length === 0 ? '' : `, or: ${rest.join(', ')}`}`;
};

/**
 * The bulk form of each single-row write — the call a loop of it collapses into. `deleteWhere` is
 * here too: the three are one situation, and naming only the two the code's name mentions would
 * hand a delete loop a fix for someone else's.
 */
const BULK_WRITE_CALLS: Readonly<Record<string, string>> = {
  insert: 'insertAll(rows)',
  update: 'updateWhere(filter, patch)',
  delete: 'deleteWhere(filter)',
};

/** An op with no bulk form of its own — a batch loop, or a name this table has not met — names both. */
const bulkWriteCall = (entityName: string, op: string | undefined): string => {
  const call = op === undefined ? undefined : BULK_WRITE_CALLS[op];
  return call !== undefined
    ? `db.${entityName}.${call}`
    : `db.${entityName}.insertAll(rows), or db.${entityName}.updateWhere(filter, patch) for a loop of patches`;
};

/**
 * A read issued once per row of a page. Reported as a `Finding` by whatever installed the statement
 * observer — `x dev`, which never throws it, and `@ultimat3/testing`'s `statements` fixture, which
 * throws it at the statement that crossed the threshold — which is why the count is in the cause
 * rather than a threshold in the fix, and why the fix is a chain and never a flag to turn the
 * warning off. `expectedQueryLoop(reason, fn)` is the one way to say a loop is deliberate, and it
 * silences the count upstream of this error rather than answering it.
 */
export const nPlusOneQuery = (subject: string, count: number, batch: QueryLoopBatch): EntityError =>
  new EntityError({
    code: 'X_N_PLUS_ONE_QUERY',
    cause: `${subject} ran ${count} times in one request — one read per row`,
    fix:
      batch.form === 'preload'
        ? preloadCalls(batch.candidates)
        : batch.form === 'in'
          ? `db.${batch.entity}.andWhere('id', 'in', ids).all()   # read the set once, then look each row up in memory`
          : `send one statement for the set — "where <key> = any($1)" — or expectedQueryLoop('<why one per row is optimal>', fn) when the loop is deliberate`,
  });

/** The same loop, writing. One statement per row is one round trip and one transaction entry each. */
export const nPlusOneWrite = (subject: string, count: number, batch: WriteLoopBatch): EntityError =>
  new EntityError({
    code: 'X_N_PLUS_ONE_WRITE',
    cause: `${subject} ran ${count} times in one request — one write per row`,
    fix:
      batch.form === 'bulk'
        ? `${bulkWriteCall(batch.entity, batch.op)}   # one statement for the whole set`
        : `send one statement for the set — "insert … values" over every row, or "update … where id = any($1)" — or expectedQueryLoop('<why one per row is optimal>', fn) when the loop is deliberate`,
  });
