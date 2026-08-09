/** Every failure @ultimat3/query can produce, one subclass per stable code. */
import { assertNever, hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';
import type { SurfaceDenial } from '@ultimat3/policy';

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

/** One class, one code: core owns the cursor codec, so core owns `X_CURSOR_INVALID`. */
export { CursorInvalidError } from '@ultimat3/core';

/** Titles for the framework-wide code table. Guarded: `X_INPUT_INVALID` is shared. */
const TITLES: Readonly<Record<string, string>> = {
  X_INPUT_INVALID: 'input failed schema validation',
  X_MATCHER_UNSUPPORTED: 'live query shape cannot be patched incrementally',
  X_QUERY_DUPLICATE: 'two queries are registered under one name',
  X_QUERY_FOREIGN: 'a value that is not a query was projected as one',
  X_QUERY_POLICY_MISSING: 'a query was registered without a policy',
  X_QUERY_UNREGISTERED: 'a query was used before it was registered',
  X_RPC_FAILED: 'an RPC call failed without a problem+json body',
};

for (const [code, title] of Object.entries(TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

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
