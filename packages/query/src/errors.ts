/** Every failure @ultimat3/query can produce, one subclass per stable code. */
import { assertNever, registerErrorCodes, UltimateError } from '@ultimat3/core';
import type { SurfaceDenial } from '@ultimat3/policy';

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

/** One class, one code: core owns the cursor codec, so core owns `X_CURSOR_INVALID`. */
export { CursorInvalidError } from '@ultimat3/core';

/** Titles for the framework-wide code table — every one of them owned by this package. */
const OWNED_TITLES: Readonly<Record<string, string>> = {
  X_CURSOR_VALUE_UNSUPPORTED: 'a sort value cannot be carried in a cursor',
  X_MATCHER_UNSUPPORTED: 'live query shape cannot be patched incrementally',
  X_QUERY_CACHE_TTL_INVALID: 'a query declares a cache ttlMs no tier can hold',
  X_QUERY_DEPRECATION_INVALID: 'a query declares a deprecation whose dates cannot be rendered',
  X_QUERY_DUPLICATE: 'two queries are registered under one name',
  X_QUERY_FOREIGN: 'a value that is not a query was projected as one',
  X_QUERY_INPUT_UNENCODABLE: 'a query input cannot be carried in a query string',
  X_QUERY_NOT_PAGEABLE: 'a read returned rows with no id, so a cursor cannot name a position',
  X_QUERY_POLICY_MISSING: 'a query was registered without a policy',
  X_QUERY_UNREGISTERED: 'a query was used before it was registered',
};

/**
 * Codes `@ultimat3/action` owns that this package only throws. Both describe an action's job —
 * enforcing an input schema, and speaking the typed RPC wire — so action declares the title and
 * query never re-declares it: two copies of a title are two titles, one of which is stale.
 */
export const QUERY_BORROWED_ERROR_CODES = ['X_INPUT_INVALID', 'X_RPC_FAILED'] as const;

// One unconditional call: a presence guard would turn "another package claims one of these codes"
// from an X_ERROR_CODE_DUPLICATE at import into whichever module loaded first deciding the title.
registerErrorCodes(
  Object.fromEntries(Object.entries(OWNED_TITLES).map(([code, title]) => [code, { title }])),
);

function denialCode(denial: SurfaceDenial): string {
  switch (denial.surface) {
    case 'http':
      return denial.problem.code;
    case 'live':
    case 'job':
      return denial.code;
    case 'mcp':
      return denial.content[0]?.text.split(':')[0] ?? 'X_FORBIDDEN';
    default:
      return assertNever(denial);
  }
}

function denialReason(denial: SurfaceDenial): string {
  switch (denial.surface) {
    case 'http':
      return denial.problem.detail;
    case 'live':
    case 'job':
      return denial.reason;
    case 'mcp':
      return denial.content[0]?.text ?? 'denied';
    default:
      return assertNever(denial);
  }
}

/**
 * An authz denial from `guard()`. The code and reason come from the policy
 * decision — this package never invents an authz code — and the surface-shaped
 * denial rides along so a live socket can close with 4403 rather than a 403 body.
 */
export class QueryDeniedError extends UltimateError {
  readonly denial: SurfaceDenial;

  constructor(query: string, denial: SurfaceDenial) {
    const code = denialCode(denial);
    super({
      code,
      cause: `${query} denied: ${denialReason(denial)}`,
      fix: `x policy explain ${query} --json   # shows which clause decided and why`,
      docs: docs(code),
    });
    this.denial = denial;
  }
}

/** Thrown when a read is used before `registerQueries()` gave it a name. */
export class QueryUnregisteredError extends UltimateError {
  constructor() {
    super({
      code: 'X_QUERY_UNREGISTERED',
      cause: 'a query was used before it was registered, so it has no name',
      fix: "call registerQueries(await import('./live')) at boot, before serving reads",
      docs: docs('X_QUERY_UNREGISTERED'),
    });
  }
}

/**
 * Thrown when a projection is handed something that never came out of `query()`.
 * The declaration is private to `read.ts`, so an object that merely looks like a
 * query has no `sql` to build and no policy to evaluate — refusing it here is how
 * "there is one read path" stays true at runtime, not just in the types.
 */
export class QueryForeignError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_QUERY_FOREIGN',
      cause: `"${name === '' ? 'anonymous' : name}" is not a query built by query()`,
      fix: "declare it as `export const name = query({ input, policy, sql })` from '@ultimat3/query'",
      docs: docs('X_QUERY_FOREIGN'),
    });
  }
}

/**
 * A read whose declared input cannot survive its own route. Thrown at `query()`, so the file that
 * wrote it is the file that fails.
 *
 * The `fix` names the three edits that exist, because which one applies depends on what the key
 * means: a structure belongs in an `action`'s JSON body, a filter can be flattened into scalar
 * keys, and an explicitly-null argument is spelled as an absent optional one.
 */
export class QueryInputUnencodableError extends UltimateError {
  constructor(offender: string) {
    super({
      code: 'X_QUERY_INPUT_UNENCODABLE',
      cause: `${offender}, and a read is served as GET /_x/query/<name> — a query string carries characters, not structures or nulls`,
      fix: 'flatten the key into scalar arguments (status: t.string, limit: t.number), spell an absent value as `.optional()` rather than `t.nullable(...)`, or declare it as an action() if it really needs a JSON body',
      docs: docs('X_QUERY_INPUT_UNENCODABLE'),
    });
  }
}

/**
 * A `cache.ttlMs` no tier will accept, refused at `query()` — so the file that wrote it fails, and
 * not every read of that query for the life of the process.
 *
 * Every `CacheTier` refuses a non-positive or non-finite lease (`assertTtl`, `X_CACHE_TTL_INVALID`)
 * and the read path's only catch absorbs `X_CACHE_TOO_LARGE`, so `ttlMs: Infinity` used to make a
 * working read fail permanently with a cause naming a cache key. The value is a number the author
 * typed, so it is echoed: it is the one fact that repairs the line.
 *
 * The query has no name yet — `query()` runs before `registerQueries()` stamps one — which is why
 * the cause describes the declaration, exactly as `X_QUERY_INPUT_UNENCODABLE` does.
 */
export class QueryCacheTtlInvalidError extends UltimateError {
  constructor(ttlMs: number) {
    super({
      code: 'X_QUERY_CACHE_TTL_INVALID',
      cause: `a query declares cache.ttlMs as ${ttlMs}, and every cache tier refuses a lease that is not positive and finite`,
      fix: 'set `cache: { ttlMs: 60_000 }` to a positive whole number of milliseconds, or drop ttlMs to take the read cache default',
      docs: docs('X_QUERY_CACHE_TTL_INVALID'),
      meta: { ttlMs },
    });
  }
}

export class QueryDuplicateError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_QUERY_DUPLICATE',
      cause: `two queries are registered under the name "${name}"`,
      fix: 'rename one export — query names are globally unique: x queries list --json',
      docs: docs('X_QUERY_DUPLICATE'),
    });
  }
}

export class QueryPolicyMissingError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_QUERY_POLICY_MISSING',
      cause: `query "${name}" was registered without a policy`,
      fix: `add \`policy: can('${name}')\` to the query definition in the file that exports it`,
      docs: docs('X_QUERY_POLICY_MISSING'),
    });
  }
}

/**
 * A `deprecated:` block whose dates cannot become the headers it promises. Refused where the
 * declaration is converted, so every projection that reads it refuses the same value — the mirror
 * of `@ultimat3/action`'s `X_ACTION_DEPRECATION_INVALID`, and for the same reason: a `Sunset`
 * header rendering `Invalid Date` is a contract statement no client can act on.
 */
export class QueryDeprecationInvalidError extends UltimateError {
  constructor(name: string, field: string, value: string) {
    super({
      code: 'X_QUERY_DEPRECATION_INVALID',
      cause: `query "${name}" declares deprecated.${field} as "${value}", which is not a date`,
      fix: `edit \`deprecated: { ${field}: … }\` on ${name} to an ISO-8601 instant — e.g. '2026-12-31T23:59:59Z'`,
      docs: docs('X_QUERY_DEPRECATION_INVALID'),
      meta: { query: name, field, value },
    });
  }
}

/**
 * Thrown when a paged or live read hands back a row with no `id`. The id is the tiebreak that
 * makes the sort order total, so without one the position a cursor names is ambiguous — and the
 * old behaviour, `String(undefined)`, signed `"undefined"` into every cursor the read issued.
 */
export class QueryNotPageableError extends UltimateError {
  constructor(entity: string | undefined) {
    const subject = entity === undefined ? 'this read' : `"${entity}"`;
    super({
      code: 'X_QUERY_NOT_PAGEABLE',
      cause: `a row from ${subject} has no "id", so a cursor cannot name its position`,
      fix: `return the primary key from the query's sql: db.${entity ?? 'rows'}.select({ id: true, … })`,
      docs: docs('X_QUERY_NOT_PAGEABLE'),
    });
  }
}

/**
 * A sort key the cursor codec cannot carry, refused where the cursor is MINTED.
 *
 * Deliberately not `X_CURSOR_INVALID`: that code means "the cursor you sent is not one of ours",
 * and its fix — request the first page again — repairs nothing here. This is the read's own
 * `orderBy` naming a column whose values are objects, `NaN` or `±Infinity`, so the repair is one
 * edit to the declaration and no retry will ever help. `Date` and `bigint` are NOT in this set:
 * `cursor-value.ts` tags both and revives them, which is the whole reason it exists.
 *
 * The description says the SHAPE and never the value — a cursor's key is row data, and a `cause`
 * reaches the log index and the problem document alike.
 */
export class CursorValueUnsupportedError extends UltimateError {
  constructor(description: string) {
    super({
      code: 'X_CURSOR_VALUE_UNSUPPORTED',
      cause: `a sort key holds ${description}, which no cursor can carry`,
      fix: 'order by a scalar column — .orderBy("createdAt") or .orderBy("id") — and project the composite value into the row instead',
      docs: docs('X_CURSOR_VALUE_UNSUPPORTED'),
    });
  }
}

/** The honest fallback: the matcher refuses to guess rather than patch wrongly. */
export class MatcherUnsupportedError extends UltimateError {
  constructor(name: string, feature: string) {
    super({
      code: 'X_MATCHER_UNSUPPORTED',
      cause: `live query "${name}" uses ${feature}, which the incremental matcher cannot patch`,
      fix: `set \`live: false\` and poll, or reshape the query to equality filters + orderBy + limit`,
      docs: docs('X_MATCHER_UNSUPPORTED'),
    });
  }
}

export class QueryInputInvalidError extends UltimateError {
  constructor(name: string, detail: string) {
    super({
      code: 'X_INPUT_INVALID',
      cause: `input for query "${name}" failed validation: ${detail}`,
      fix: `x queries describe ${name} --json  # prints the expected input schema`,
      docs: docs('X_INPUT_INVALID'),
    });
  }
}

/** The `problem+json` fields a failing read can send back. All optional: a proxy sends none. */
export interface QueryProblem {
  readonly code?: unknown;
  readonly cause?: unknown;
  readonly detail?: unknown;
  readonly fix?: unknown;
  readonly docs?: unknown;
}

/**
 * The typed client's failure. A `problem+json` body is re-thrown verbatim — the
 * server already said what broke and how to fix it, and inventing a second story
 * here would bury it. Anything else answered instead of the app, so it is
 * `X_RPC_FAILED` and the fix line points at the gateway.
 */
export class QueryRequestFailedError extends UltimateError {
  constructor(name: string, status: number, problem: QueryProblem = {}) {
    const code = text(problem.code) ?? 'X_RPC_FAILED';
    super({
      code,
      cause: text(problem.cause) ?? text(problem.detail) ?? `${name} returned HTTP ${status}`,
      fix:
        text(problem.fix) ??
        `check the gateway in front of the app, then: x queries describe ${name} --json`,
      docs: text(problem.docs) ?? docs(code),
    });
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
