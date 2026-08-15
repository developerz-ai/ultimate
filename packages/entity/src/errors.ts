// The entity layer's stable error codes. Each factory produces the exact command
// that fixes the situation — `X_DB_DRIFT` is the flagship: it names the table, the
// column and the generator invocation.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const ENTITY_OWNED_ERROR_CODES = [
  'X_ENTITY_DUPLICATE',
  'X_INVARIANT_VIOLATED',
  'X_TENANCY_UNSCOPED',
  'X_TENANCY_ACTOR_MISMATCH',
  'X_TENANCY_ACTOR_ORG_REQUIRED',
  'X_TENANCY_CROSS_DENIED',
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
  X_TENANCY_ACTOR_MISMATCH: "a query named a tenant other than the actor's",
  X_TENANCY_ACTOR_ORG_REQUIRED: 'the acting actor carries no tenant',
  X_TENANCY_CROSS_DENIED: 'a cross-tenant read was entered without the capability',
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

/**
 * Reached only where there is no actor to derive the tenant from — outside every request context,
 * which is a script, a boot path or a test harness. Inside one the tenant is the actor's and this
 * plan would have been scoped without anybody naming it, so the fix leads with the context rather
 * than with the argument: naming the tenant by hand is the fallback, and it is now checked against
 * the actor wherever there is one.
 */
export const tenancyUnscoped = (entityName: string, operation: string): EntityError =>
  new EntityError({
    code: 'X_TENANCY_UNSCOPED',
    cause: `${entityName}.${operation}() was built without an org predicate but the entity has an orgId column, and no request context carried an actor to take the tenant from`,
    fix: `run it inside runWithContext(createContext({ actor: userActor({ id, orgId }) }), fn) — the actor's org scopes the plan — or name the tenant: ${entityName}.${operation}({ orgId }), which orgScoped(plan, orgId) is the plan-level form of`,
  });

/**
 * The vulnerability this whole guard exists for: an `orgId` that arrived as action input, a query
 * argument or a path parameter, passed into a repository call that then read somebody else's rows.
 * Both values are in the cause because that is the only way a reader can tell an attack from a
 * handler that threaded the wrong variable — an org id is an opaque identifier, not a secret.
 *
 * Refused rather than overridden: silently rewriting the predicate to the actor's org would hand
 * back a correct answer to a call that asked the wrong question, and the bug would ship.
 */
export const tenancyActorMismatch = (init: {
  entityName: string;
  operation: string;
  named: unknown;
  actorOrg: string;
}): EntityError => {
  // `undefined` is a real case — `where('orgId', 'is-null')` names the column and no value — and
  // `JSON.stringify` answers it with `undefined` rather than a string, which would render the two
  // halves of the cause differently.
  const named = JSON.stringify(init.named) ?? 'undefined';
  return new EntityError({
    code: 'X_TENANCY_ACTOR_MISMATCH',
    cause: `${init.entityName}.${init.operation}() was scoped to tenant ${named} but the acting actor's tenant is ${JSON.stringify(init.actorOrg)}`,
    fix: `drop the orgId argument from ${init.entityName}.${init.operation}() — the actor's tenant scopes it — or act as that tenant: withChildContext({ actor: userActor({ id, orgId: ${named} }) }, fn). A read that must span tenants is crossTenant('<why>', fn)`,
  });
};

/**
 * A tenant-scoped read by an actor that carries no tenant — anonymous, or a service actor minted
 * without one. Refused, and deliberately not softened into "then the caller's value stands": that
 * fallback is exactly the hole, because an unauthenticated request would name any tenant it liked.
 *
 * Same shape as `@ultimat3/flags`' `X_FLAG_SUBJECT_REQUIRED`: an absent fact is not a satisfied
 * one, and the repair is at the boundary that mints the actor, so the fix names that call.
 */
export const tenancyActorOrgRequired = (init: {
  entityName: string;
  operation: string;
  actorId: string;
  actorKind: string;
}): EntityError =>
  new EntityError({
    code: 'X_TENANCY_ACTOR_ORG_REQUIRED',
    cause: `${init.entityName}.${init.operation}() reads a tenant-scoped entity, but the ${init.actorKind} actor ${JSON.stringify(init.actorId)} carries no orgId — there is no tenant to scope it to`,
    fix: `mint the actor with its tenant at the request boundary — userActor({ id: ${JSON.stringify(init.actorId)}, orgId: '<org>' }) — or, for a sweep that legitimately spans tenants, crossTenant('<why>', fn)`,
  });

/**
 * The escape hatch refusing to open. It names the scope string because that is what the operator
 * has to grant, and it fires at `crossTenant()` itself rather than at the first query inside it —
 * the call that asked for the capability is the one that has to be repaired.
 */
export const crossTenantDenied = (init: {
  reason: string;
  actor: string;
  scope: string;
}): EntityError =>
  new EntityError({
    code: 'X_TENANCY_CROSS_DENIED',
    cause: `crossTenant(${JSON.stringify(init.reason)}) was entered by ${init.actor}, which does not carry the ${JSON.stringify(init.scope)} scope`,
    fix: `grant the capability where the actor is minted — serviceActor({ id: 'reconciler', scopes: ['${init.scope}'] }) — and run the sweep inside runWithContext(createContext({ actor }), fn); an ordinary request scopes to its own tenant instead and needs no crossTenant()`,
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
