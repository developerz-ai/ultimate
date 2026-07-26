/**
 * Every failure @ultimat3/action can produce, one subclass per stable code so
 * callers `instanceof` a specific failure instead of string-matching a message.
 */
import { assertNever, hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';
import type { SurfaceDenial } from '@ultimat3/policy';

const docs = (code: string): string => `https://ultimate.dev/errors/${code}`;

/** Titles for the framework-wide code table. Guarded: `X_INPUT_INVALID` is shared. */
const TITLES: Readonly<Record<string, string>> = {
  X_ACTION_DUPLICATE: 'two actions are registered under one name',
  X_ACTION_POLICY_MISSING: 'an action was registered without a policy',
  X_ACTION_UNREGISTERED: 'an action was projected before it was registered',
  X_CONTRACT_DRIFT: 'client and server disagree about the contract',
  X_IDEMPOTENCY_CONFLICT: 'idempotency key reused with a different payload or still in flight',
  X_INPUT_INVALID: 'input failed schema validation',
  X_RPC_FAILED: 'an RPC call failed without a problem+json body',
};

for (const [code, title] of Object.entries(TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

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
