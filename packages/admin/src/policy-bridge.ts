// The ONLY place the admin talks to @ultimat3/policy. Everything else in the package depends
// on the `AdminAuthz` interface, so there is exactly one adaptation point between the app's
// policies and the dashboard — and no second authz implementation can grow next to it.

import { definePermissions, evaluate, type Policy } from '@ultimat3/policy';
import { type AdminAuthz, type AdminDecision, allowed, denied } from './authz';
import { ADMIN_PERMISSION_SPEC } from './permissions';

/** The admin's own permission set, registered with the policy layer at import time. */
export const adminPermissions = definePermissions(ADMIN_PERMISSION_SPEC);

/**
 * `evaluate()`'s result is read structurally: the policy layer owns its own decision type,
 * and the admin only needs the verdict, a reason key, and the trace it prints in `/_x`.
 */
function readDecision(permission: string, result: unknown): AdminDecision {
  const bag = (typeof result === 'object' && result !== null ? result : {}) as {
    allowed?: unknown;
    reason?: unknown;
    trace?: unknown;
  };
  const verdict = result === true || bag.allowed === true;
  const reason = typeof bag.reason === 'string' ? bag.reason : 'admin.policy.evaluated';
  const trace = Array.isArray(bag.trace) ? bag.trace.map((line) => String(line)) : [];
  return verdict ? allowed(permission, reason, trace) : denied(permission, reason, trace);
}

export interface PolicyAuthzInput {
  /** Permission name → the policy that decides it. `describeActions()` supplies these. */
  readonly policies: Readonly<Record<string, Policy>>;
}

/**
 * Closed by default: a permission with no registered policy is denied, with the fix in the
 * trace. An admin that fails open is worse than an admin that fails visibly.
 */
export function policyAuthz(input: PolicyAuthzInput): AdminAuthz {
  return {
    decide({ permission, actor, subject }): AdminDecision {
      const policy = input.policies[permission];
      if (policy === undefined) {
        return denied(permission, 'admin.policy.missing', [
          `no policy registered for "${permission}"`,
          `fix: definePermissions({ '${permission}': … }) or can('${permission}') on the action`,
        ]);
      }
      return readDecision(permission, evaluate(policy, { actor, input: subject?.input, subject }));
    },
  };
}
