// The ONLY place the admin talks to @ultimat3/policy. Everything else in the package depends
// on the `AdminAuthz` interface, so there is exactly one adaptation point between the app's
// policies and the dashboard — and no second authz implementation can grow next to it.

import { type Actor, userActor } from '@ultimat3/core';
import { definePermissions, evaluate, type Policy } from '@ultimat3/policy';
import { type AdminActor, type AdminAuthz, type AdminDecision, allowed, denied } from './authz';
import { ADMIN_PERMISSIONS } from './permissions';

/** The admin's own permission set, registered with the policy layer at import time. */
export const adminPermissions = definePermissions(ADMIN_PERMISSIONS);

/**
 * The admin carries its own actor shape; @ultimat3/policy evaluates core's `Actor`. The
 * mapping lives here because this file is the only one allowed to speak to the policy layer.
 */
const policyActor = (actor: AdminActor): Actor =>
  userActor({ id: actor.id, roles: actor.roles ?? [] });

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
      // `EvaluateArgs` carries exactly one payload. An admin subject with no action input IS
      // that payload: a row-level rule has nothing but the entity and id to decide on.
      const payload = subject?.input ?? subject;
      return readDecision(
        permission,
        evaluate(policy, { actor: policyActor(actor), input: payload }),
      );
    },
  };
}
