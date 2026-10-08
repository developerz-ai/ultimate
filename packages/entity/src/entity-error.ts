// The entity layer's code registry, its error class, and the two refusals the declaration path
// raises — split from `errors.ts` so a module the BROWSER loads (the record key, the projection,
// the registry) can raise one without importing `@ultimat3/db`.
import type { ErrorRetry } from '@ultimat3/core';
import {
  isFixShellSafe,
  registerErrorCodes,
  registerErrorRetry,
  UltimateError,
} from '@ultimat3/core';

/**
 * Every code this package throws, and it owns each one. `X_DB_DRIFT` is `@ultimat3/db`'s and is
 * raised there — drift is a fact about migrations.
 */
export const ENTITY_ERROR_CODES = [
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
  'X_AGGREGATE_UNSUPPORTED',
  'X_AGGREGATE_MIXED_CURRENCY',
  'X_APPROXIMATE_COUNT_FILTERED',
  'X_SEARCH_UNDECLARED',
  'X_SEARCH_IN_MEMORY',
  'X_STATE_UNDECLARED',
  'X_STATE_TRANSITION_ILLEGAL',
  'X_STATE_CONFLICT',
  'X_RECORD_KEY_MISSING',
  'X_ENTITY_SEALED_PREDICATE',
  'X_ENTITY_SEALED_IN_VIEW',
  'X_ENTITY_APPEND_ONLY',
] as const;

export type EntityErrorCode = (typeof ENTITY_ERROR_CODES)[number];

export const ENTITY_ERROR_TITLES: Readonly<Record<EntityErrorCode, string>> = {
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
  X_AGGREGATE_UNSUPPORTED: 'that column has no aggregate both drivers can answer alike',
  X_AGGREGATE_MIXED_CURRENCY: 'an amount was aggregated across currencies',
  X_APPROXIMATE_COUNT_FILTERED: 'an estimate was asked of a filtered chain',
  X_SEARCH_UNDECLARED: 'this entity has no searchable column',
  X_SEARCH_IN_MEMORY: 'the in-memory driver cannot answer a full-text match',
  X_STATE_UNDECLARED: 'that column declares no state machine',
  X_STATE_TRANSITION_ILLEGAL: 'the machine has no such transition',
  X_STATE_CONFLICT: 'the row changed after the read this transition was decided on',
  X_RECORD_KEY_MISSING: 'a row reached its record key without a primary-key value',
  X_ENTITY_SEALED_PREDICATE:
    'a sealed column is read by a predicate, an order or a rule the database evaluates',
  X_ENTITY_SEALED_IN_VIEW: 'a sealed column is named in a view',
  X_ENTITY_APPEND_ONLY: 'an append-only entity was asked to rewrite or remove a row',
};

// Registered at module load, unconditionally, in one call. Without this the registry humanises the
// code and every surface renders a title this package never wrote; with a presence guard, a second
// package claiming one of these codes would silently win instead of throwing X_ERROR_CODE_DUPLICATE.
registerErrorCodes(
  Object.fromEntries(Object.entries(ENTITY_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * How the codes here that are worth classifying are retried. The two sealed-column refusals and
 * the append-only refusal: each is the app's own declaration or call, so attempt five answers what attempt one did — and
 * left unclassified, `classifyThrown` reads them as undecided and a job spends its whole retry
 * policy re-proving it. Listed although `terminal` is the default, for the reason core's own table
 * gives for `X_NOT_IMPLEMENTED`. The rest of this package's codes are unclassified, as they were.
 */
export const ENTITY_ERROR_RETRY = {
  X_ENTITY_SEALED_PREDICATE: 'terminal',
  X_ENTITY_SEALED_IN_VIEW: 'terminal',
  X_ENTITY_APPEND_ONLY: 'terminal',
} as const satisfies Readonly<Partial<Record<EntityErrorCode, ErrorRetry>>>;

registerErrorRetry(ENTITY_ERROR_RETRY);

/**
 * Base for every error this package throws. No `docs:` — `UltimateError` fills it from
 * `describeErrorCode(code).docs`, which is `@ultimat3/core`'s `ERROR_DOCS_URL`: one page for every
 * code, never one per code, because `wiki/` is the framework's only public documentation surface
 * and a code lives there in a TABLE ROW, which has no anchor. The
 * `https://ultimate.dev/errors/<code>` links this class built until 9.x answered 404, host
 * included, on every refusal it has ever raised.
 */
export class EntityError extends UltimateError {
  override readonly name = 'EntityError';

  constructor(init: { code: EntityErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
    });
  }
}

/**
 * The one command a BOUND refusal hands back — a page size, a preload ceiling, a judged write: it
 * runs, and it names the real entity. The edit itself is code on a chain whose variable no error
 * can know (`db.members`, not `preload_test_members`), so it is spelled in the `cause` as the call
 * to write, never in the `fix` as though the entity name were that variable. A name a shell would
 * read is not spliced.
 */
export const describeCommand = (entityName: string): string =>
  isFixShellSafe(entityName) ? `x entities show ${entityName} --json` : 'x entities list --json';

/**
 * The entity name is a VALUE, never a literal — `entity.$name`, `table`, the `name` `entity()` was
 * given. A literal is an entity that does not exist, and this fix then hands the reader
 * `x entities show column --json`, which answers `X_DECLARATION_UNKNOWN` (issue #290). A
 * refusal raised before any entity exists belongs in `refuse.ts`, where the caller supplies the
 * edit; `refuse.test.ts` fails on a literal here.
 */
export const invariantViolated = (
  entityName: string,
  invariantName: string,
  message: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.${invariantName}: ${message}`,
    fix: `x entities show ${entityName} --json   # shows the invariant and its SQL CHECK`,
  });

export const entityDuplicate = (name: string, existingTable: string): EntityError =>
  new EntityError({
    code: 'X_ENTITY_DUPLICATE',
    cause: `entity "${name}" is already registered for table "${existingTable}"`,
    fix: `x entities list --json   # then rename one of the two entity({ name }) declarations`,
  });
