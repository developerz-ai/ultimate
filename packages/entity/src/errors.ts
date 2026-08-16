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
  'X_REPO_CLIENT_PINNED',
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
  // "call", not "query": the same code covers a predicate that names another tenant and a row or
  // patch that writes one, because they are one mistake made in two places.
  X_TENANCY_ACTOR_MISMATCH: "a call named a tenant other than the actor's",
  X_TENANCY_ACTOR_ORG_REQUIRED: 'the acting actor carries no tenant',
  X_TENANCY_CROSS_DENIED: 'a cross-tenant read was entered without the capability',
  X_NOT_FOUND: 'no row for that id',
  X_WRITE_UNFILTERED: 'a filtered write named no filter columns',
  X_PATCH_EMPTY: 'a filtered update named no columns to write',
  X_PRELOAD_UNKNOWN_RELATION: 'no relation of that name on this entity',
  X_N_PLUS_ONE_QUERY: 'a read repeated once per row',
  X_N_PLUS_ONE_WRITE: 'a write repeated once per row',
  X_REPO_CLIENT_PINNED: 'a repository pinned to its own client cannot join the open transaction',
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

/**
 * A value from an app, rendered for a `cause` — and it may not throw, whatever the app put there.
 * `JSON.stringify` raises a `TypeError` on a bigint and on a cyclic structure, and runs any
 * `toJSON` the value carries, so building the message could raise INSTEAD of the refusal: the
 * caller then gets `TypeError: cannot serialize BigInt` where a tenancy denial belongs, catching
 * by code finds nothing to catch, and an HTTP surface answers 500 rather than the mapped status.
 * A security refusal is the last message in the framework that may be lost to its own formatting.
 *
 * A cause DESCRIBES, so degrading to a type name costs nothing a reader needs; the `fix:` lines
 * that must parse take the stricter route beside each one — a string, or a placeholder.
 * Interpolation is avoided for the same reason: `${symbol}` throws where `String(symbol)` does not.
 */
const renderValue = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return String(value);
  try {
    // `undefined` for a function or a symbol-keyed nothing; the type name is the honest answer.
    return JSON.stringify(value) ?? `a ${typeof value}`;
  } catch {
    return `a ${typeof value} that cannot be rendered`;
  }
};

/**
 * The same value where the text has to PARSE: a string literal, or the placeholder that stands in
 * for one. The placeholder is a parameter because what is missing differs — an org in one fix line,
 * an actor id in another — and a fix that names the wrong thing is not one.
 */
const asLiteral = (value: unknown, placeholder: string): string =>
  typeof value === 'string' ? JSON.stringify(value) : placeholder;

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
    fix: `x entities describe ${entityName} --json   # shows the invariant and its SQL CHECK`,
  });

/**
 * One code, two situations, and they do not share a repair — so the cause and the fix branch on
 * which one it is rather than one wording claiming the other's facts.
 *
 * `actorOrg` absent: no request context at all, which is a script, a boot path or a test harness.
 * Nothing derived the tenant because there was no actor to derive it from, so the fix leads with
 * the context and offers naming the tenant by hand as the fallback.
 *
 * `actorOrg` present: `assertScoped` was handed a plan somebody else built. It cannot derive — a
 * verifier has nowhere to put a predicate — so the fix names the two calls that can.
 */
export const tenancyUnscoped = (
  entityName: string,
  operation: string,
  actorOrg?: string,
): EntityError =>
  new EntityError({
    code: 'X_TENANCY_UNSCOPED',
    cause:
      actorOrg === undefined
        ? `${entityName}.${operation}() was built without an org predicate but the entity has an orgId column, and no request context carried an actor to take the tenant from`
        : `${entityName}.${operation}() was checked against a plan with no org predicate, though the acting actor's tenant is ${renderValue(actorOrg)} — a plan is verified here, never rewritten, so the tenant had to be on it already`,
    fix:
      actorOrg === undefined
        ? `run it inside runWithContext(createContext({ actor: userActor({ id, orgId }) }), fn) — the actor's org scopes the plan — or name the tenant: ${entityName}.${operation}({ orgId }), which orgScoped(plan, orgId) is the plan-level form of`
        : `build the plan with scopedPlan('${entityName}', tenantColumn, '${operation}', plan) — it applies the actor's tenant — or add the predicate first: orgScoped(plan, ${asLiteral(actorOrg, "'<org>'")})`,
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
  // a predicate carries whatever the app put in it, which is why both halves go through
  // `renderValue`: a bigint or a cyclic value here would otherwise throw in place of the refusal.
  // The fix takes the strict route — `where('orgId', 'in', [a, b])` and `is-null` both reach here,
  // and neither `orgId: ["a","b"]` nor `orgId: undefined` is an org anybody can act as.
  return new EntityError({
    code: 'X_TENANCY_ACTOR_MISMATCH',
    cause: `${init.entityName}.${init.operation}() was scoped to tenant ${renderValue(init.named)} but the acting actor's tenant is ${renderValue(init.actorOrg)}`,
    fix: `drop the orgId argument from ${init.entityName}.${init.operation}() — the actor's tenant scopes it — or act as that tenant: withChildContext({ actor: userActor({ id, orgId: ${asLiteral(init.named, "'<org>'")} }) }, fn). A read that must span tenants is crossTenant('<why>', fn)`,
  });
};

/**
 * The write half of the same mistake, and deliberately the SAME code: a tenant the caller chose,
 * named in a row or a patch instead of in a predicate. One situation, one code — the shape
 * `crossTenantUpsert` and `tenancyUnscoped` already share in `bulk-write.ts` — because a caller
 * catching "the tenant you named is not yours" has no reason to care which argument carried it.
 * Only the repair differs, so only the `fix` does.
 *
 * The actor's own tenant goes in the fix because it is the value that makes the call legal and it
 * is pasteable; the row's is in the cause, where a non-scalar can do no harm.
 */
export const tenancyRowMismatch = (init: {
  entityName: string;
  operation: string;
  column: string;
  named: unknown;
  actorOrg: string;
}): EntityError =>
  new EntityError({
    code: 'X_TENANCY_ACTOR_MISMATCH',
    // A row literal is the least constrained input in the framework — this guard runs BEFORE
    // `$assert`, on purpose, so the value has been through no parse at all when it is rendered.
    cause: `${init.entityName}.${init.operation}() would write ${init.column} ${renderValue(init.named)} but the acting actor's tenant is ${renderValue(init.actorOrg)}`,
    fix: `set ${init.column} to ${asLiteral(init.actorOrg, "'<org>'")} in the row passed to ${init.entityName}.${init.operation}(), or write into another tenant deliberately: crossTenant('<why>', fn)`,
  });

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
    cause: `${init.entityName}.${init.operation}() reads a tenant-scoped entity, but the ${init.actorKind} actor ${renderValue(init.actorId)} carries no orgId — there is no tenant to scope it to`,
    fix: `mint the actor with its tenant at the request boundary — userActor({ id: ${asLiteral(init.actorId, "'<actor id>'")}, orgId: '<org>' }) — or, for a sweep that legitimately spans tenants, crossTenant('<why>', fn)`,
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

/**
 * A repository built with an explicit `client`, used while a transaction is open.
 *
 * Refused rather than resolved, because neither answer is available. `withTransaction` reserves
 * ONE connection and runs `BEGIN` on it — the ambient pool's, or a reservation of its own
 * `client:` option — while a repository pinned through `postgresDriver({ client })` sends every
 * statement straight to that client, which takes a different connection out of the pool. So the
 * write commits immediately and survives the rollback, and the read cannot see the rows the
 * transaction has already written; both are silent. Joining the transaction instead would be the
 * worse half of the same guess: a `DbTx` does not name the client it was opened on, so "is this
 * even the same database" is not a question this layer can ask, and on a sharded app the answer
 * is no.
 *
 * The fix names the ambient seam because that is the one path a repository joins a transaction
 * through: `db()` resolves `currentTx()` first, which is exactly what a pinned client skips.
 */
export const repoClientPinned = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_REPO_CLIENT_PINNED',
    cause: `${entityName} is served by a repository pinned to its own client, and a transaction is open — its statements would run on another connection, outside that transaction, committed whether it commits or rolls back`,
    fix: `setDbClient(client) at boot and build the repository with no client: — postgresDriver() then resolves the open transaction through db() — or run this call outside withTransaction()`,
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
    fix: `repo.findMany({ includeDeleted: true, limit: 5 })   # a soft-deleted row answers there and never from findById`,
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
