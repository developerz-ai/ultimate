/**
 * Every failure @ultimat3/action can produce, one subclass per stable code so
 * callers `instanceof` a specific failure instead of string-matching a message.
 */
import {
  assertNever,
  ERROR_DOCS_BASE,
  errorDocsUrl,
  hasErrorCode,
  registerErrorCodes,
  UltimateError,
} from '@ultimat3/core';
import type { SurfaceDenial } from '@ultimat3/policy';

// Core's spelling, aliased — never a second one. A local template drifts from what
// `x errors explain` prints the moment `ERROR_DOCS_BASE` moves.
const docs = errorDocsUrl;

/**
 * Titles for the framework-wide code table — every one of them owned by this package.
 * `X_INPUT_INVALID` and `X_RPC_FAILED` are action's: an action is where an input schema is
 * enforced and where the typed client speaks, and `@ultimat3/query` only throws them.
 * Authz codes are absent on purpose — `ActionDeniedError` re-uses the policy decision's code.
 */
const OWNED_TITLES: Readonly<Record<string, string>> = {
  X_ACTION_DUPLICATE: 'two actions are registered under one name',
  X_ACTION_PATH_DUPLICATE: 'two actions derive one HTTP path',
  X_ACTION_FOREIGN: 'a value that is not an action was projected as one',
  X_ACTION_POLICY_MISSING: 'an action was registered without a policy',
  X_ACTION_UNREGISTERED: 'an action was projected before it was registered',
  X_CONTRACT_DRIFT: 'client and server disagree about the contract',
  X_IDEMPOTENCY_CONFLICT: 'idempotency key reused with a different payload or still in flight',
  X_INPUT_INVALID: 'input failed schema validation',
  X_OUTPUT_INVALID: 'a handler returned a value its output schema rejects',
  X_RPC_FAILED: 'an RPC call failed without a problem+json body',
};

// One unconditional call: a presence guard would turn "another package claims one of these codes"
// from an X_ERROR_CODE_DUPLICATE at import into whichever module loaded first deciding the title.
registerErrorCodes(
  Object.fromEntries(Object.entries(OWNED_TITLES).map(([code, title]) => [code, { title }])),
);

/** Thrown when a projection needs a name the action does not have yet. */
export class ActionUnregisteredError extends UltimateError {
  constructor() {
    super({
      code: 'X_ACTION_UNREGISTERED',
      cause: 'an action was projected before it was registered, so it has no name',
      fix: "call registerActions(await import('./actions')) at boot, before mounting routes",
      docs: docs('X_ACTION_UNREGISTERED'),
    });
  }
}

/**
 * Thrown when a projection is handed something that never came out of `action()`.
 * The declaration is private to `invoke.ts`, so an object that merely looks like
 * an action has no handler to run and no policy to evaluate — refusing it here is
 * how "there is one execution path" stays true at runtime, not just in the types.
 */
export class ActionForeignError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_ACTION_FOREIGN',
      cause: `"${name === '' ? 'anonymous' : name}" is not an action built by action()`,
      fix: "declare it as `export const name = action({ input, output, policy, handle })` from '@ultimat3/action'",
      docs: docs('X_ACTION_FOREIGN'),
    });
  }
}

export function denialCode(denial: SurfaceDenial): string {
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

export function denialReason(denial: SurfaceDenial): string {
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
 * An authz denial, thrown by `guard()`. The code and reason come from the policy
 * decision — this package never invents an authz code — and the surface-shaped
 * denial rides along for projections that render it themselves.
 */
export class ActionDeniedError extends UltimateError {
  readonly denial: SurfaceDenial;

  constructor(action: string, denial: SurfaceDenial) {
    const code = denialCode(denial);
    super({
      code,
      cause: `${action} denied: ${denialReason(denial)}`,
      fix: `x policy explain ${action} --json   # shows which clause decided and why`,
      docs: docs(code),
    });
    this.denial = denial;
  }
}

export class ActionDuplicateError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_ACTION_DUPLICATE',
      cause: `two actions are registered under the name "${name}"`,
      fix: `rename one export — action names are globally unique: x actions list --json`,
      docs: docs('X_ACTION_DUPLICATE'),
    });
  }
}

/**
 * Two distinct action names, one derived route. `X_ACTION_DUPLICATE` guards the NAME; nothing
 * guarded the path, so `archiveOrder` and `archiveOrders` both registered, both projected to
 * `POST /api/orders/archive`, and whichever the router seated last silently shadowed the other —
 * while the shadowed action's OpenAPI operation and MCP tool went on advertising it.
 */
export class ActionPathDuplicateError extends UltimateError {
  constructor(input: { name: string; existing: string; path: string }) {
    super({
      code: 'X_ACTION_PATH_DUPLICATE',
      cause: `actions "${input.name}" and "${input.existing}" both derive ${input.path}`,
      fix: `rename one export so the two derive different paths — x actions list --json prints every derived route`,
      docs: docs('X_ACTION_PATH_DUPLICATE'),
    });
  }
}

export class ActionPolicyMissingError extends UltimateError {
  constructor(name: string) {
    super({
      code: 'X_ACTION_POLICY_MISSING',
      cause: `action "${name}" was registered without a policy`,
      fix: `add \`policy: can('${name}')\` to the action definition in the file that exports it`,
      docs: docs('X_ACTION_POLICY_MISSING'),
    });
  }
}

export class InputInvalidError extends UltimateError {
  constructor(name: string, detail: string) {
    super({
      code: 'X_INPUT_INVALID',
      cause: `input for action "${name}" failed validation: ${detail}`,
      fix: `x actions describe ${name} --json  # prints the expected input schema`,
      docs: docs('X_INPUT_INVALID'),
    });
  }
}

/**
 * The mirror of `InputInvalidError`, and a server bug rather than a caller's:
 * the handler produced something its own `output` schema rejects, so the client,
 * the OpenAPI response and the MCP `outputSchema` would all have been lied to.
 */
export class OutputInvalidError extends UltimateError {
  constructor(name: string, detail: string) {
    super({
      code: 'X_OUTPUT_INVALID',
      cause: `action "${name}" returned a value its output schema rejects: ${detail}`,
      fix: `x actions describe ${name} --json  # compare the handler's return against \`output:\``,
      docs: docs('X_OUTPUT_INVALID'),
    });
  }
}

export type IdempotencyConflictReason = 'payload-mismatch' | 'in-flight';

export class IdempotencyConflictError extends UltimateError {
  constructor(key: string, reason: IdempotencyConflictReason) {
    super({
      code: 'X_IDEMPOTENCY_CONFLICT',
      cause:
        reason === 'payload-mismatch'
          ? `idempotency key "${key}" was already used with a different payload`
          : `idempotency key "${key}" is still in flight from an earlier request`,
      fix:
        reason === 'payload-mismatch'
          ? 'send a fresh Idempotency-Key header for a different payload'
          : 'retry the same Idempotency-Key after the first request settles',
      docs: docs('X_IDEMPOTENCY_CONFLICT'),
    });
  }
}

/** What the wire said, once `client.ts` has decided the body really is a problem document. */
export interface RemoteFailure {
  /** The action that was called — `meta` carries it, so a report names the call, not just a code. */
  readonly action: string;
  readonly status: number;
  /** The server's code, kept verbatim: matching on it is why problem+json carries one. */
  readonly code: string;
  readonly cause: string;
  readonly fix: string;
  /**
   * The links the server offered, most specific first. Never synthesized from the code, and
   * never trusted for being present — the first one that is an absolute HTTP(S) URL wins, so
   * a `javascript:` in the preferred slot cannot suppress a usable link behind it.
   */
  readonly docs?: readonly (string | undefined)[] | undefined;
}

/** A link, not a string the server happened to put in a field the overlay renders as an href. */
const ABSOLUTE_HTTP_URL = /^https?:\/\//;

/**
 * The docs link, or the honest absence of one. `UltimateError` resolves an unregistered code to
 * `https://ultimate.dev/errors/<code>`, and a code the SERVER owns — `X_SIGNUP_CLOSED`, declared
 * by the app through `registerErrorStatus` — is exactly the kind this bundle never registered:
 * that URL is a 404 dressed as documentation, printed under `docs:` as if the framework wrote the
 * page. So: the server's own link when it sent a resolvable one, this build's registered link
 * when it knows the code, and otherwise the index — a page that exists.
 *
 * `sent` is ordered, not singular: a server that fills `docs` with a `javascript:` URI still
 * sent RFC-9457's `type`, and taking the first *resolvable* candidate means the unusable one
 * costs nothing. Testing only the preferred slot would have dropped a valid link on the floor.
 */
function remoteDocs(code: string, sent: readonly (string | undefined)[] = []): string | undefined {
  const link = sent.find((value) => value !== undefined && ABSOLUTE_HTTP_URL.test(value));
  if (link !== undefined) return link;
  // `undefined` lets the constructor resolve the REGISTERED descriptor, whose docs a package
  // may have declared as something other than the default URL.
  return hasErrorCode(code) ? undefined : ERROR_DOCS_BASE;
}

/**
 * A failure the SERVER raised, rebuilt from `application/problem+json` in the browser. The code
 * is the server's — this package invents none, the same rule `ActionDeniedError` follows for a
 * policy decision — but a code the server owns is one this bundle may never have registered, so
 * the error says where it came from rather than passing as locally declared: `name` marks it in
 * a stack trace and `meta.origin` marks it in `--json`, the dev overlay and the error reporter.
 * `RpcFailedError` stays the answer when no framework code came back at all.
 */
export class RemoteActionError extends UltimateError {
  override readonly name = 'RemoteActionError';
  /** The status that carried it — typed, so a caller never digs it back out of `meta`. */
  readonly status: number;

  constructor(failure: RemoteFailure) {
    super({
      code: failure.code,
      cause: failure.cause,
      fix: failure.fix,
      docs: remoteDocs(failure.code, failure.docs),
      meta: { origin: 'remote', action: failure.action, status: failure.status },
    });
    this.status = failure.status;
  }
}

/** The client got a non-`problem+json` failure — a proxy, not our server, answered. */
export class RpcFailedError extends UltimateError {
  constructor(name: string, status: number) {
    super({
      code: 'X_RPC_FAILED',
      cause: `${name} returned HTTP ${status} without a problem+json body`,
      fix: `check the gateway in front of the app, then: x actions describe ${name} --json`,
      docs: docs('X_RPC_FAILED'),
    });
  }
}

export class ContractDriftError extends UltimateError {
  constructor(cause: string, fix: string) {
    super({ code: 'X_CONTRACT_DRIFT', cause, fix, docs: docs('X_CONTRACT_DRIFT') });
  }
}
