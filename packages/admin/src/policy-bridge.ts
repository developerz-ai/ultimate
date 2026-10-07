// The ONLY place the admin talks to @ultimat3/policy. Everything else in the package depends
// on the `AdminAuthz` interface, so there is exactly one adaptation point between the app's
// policies and the dashboard — and no second authz implementation can grow next to it.

import { type Actor, userActor } from '@ultimat3/core';
import {
  can,
  definePermissions,
  evaluate,
  isKnownPermission,
  type KnownPermission,
  type Permission,
  type Policy,
} from '@ultimat3/policy';
import {
  type AdminActor,
  type AdminAuthz,
  type AdminDecision,
  type AdminSubject,
  adminAllowed,
  adminDenied,
  impliersOf,
} from './authz';
import { ADMIN_PERMISSIONS } from './permissions';

/**
 * The admin carries its own actor shape; @ultimat3/policy evaluates core's `Actor`. The
 * mapping lives here because this file is the only one allowed to speak to the policy layer.
 */
const policyActor = (actor: AdminActor): Actor =>
  // `orgId` rides along, and its absence used to be silent: every admin decision was evaluated
  // with `actor.orgId === undefined`, so an org-scoped rule could not fire and a role-only rule
  // allowed a row from another tenant.
  userActor({ id: actor.id, roles: actor.roles ?? [], orgId: actor.orgId });

/**
 * `evaluate()`'s result is read structurally: the policy layer owns its own decision type,
 * and the admin only needs the verdict, a reason key, and the trace it prints in `/_x`.
 */
function readDecision(permission: string, result: unknown): AdminDecision {
  const bag = (typeof result === 'object' && result !== null ? result : {}) as {
    allowed?: unknown;
    decision?: unknown;
    trace?: unknown;
  };
  // The reason lives on the evaluation's `decision`, not beside `allowed`. It was read off the top
  // level, where no evaluation has ever carried one, so every refusal an operator read said
  // `admin.policy.evaluated` — the same string whichever rule refused them.
  const inner = (typeof bag.decision === 'object' && bag.decision !== null ? bag.decision : {}) as {
    reason?: unknown;
  };
  const verdict = result === true || bag.allowed === true;
  const reason = typeof inner.reason === 'string' ? inner.reason : 'admin.policy.evaluated';
  const trace = Array.isArray(bag.trace) ? bag.trace.map((line) => String(line)) : [];
  return verdict ? adminAllowed(permission, reason, trace) : adminDenied(permission, reason, trace);
}

/** `resource:verb` — the only shape `can()` takes. Anything else is denied, never thrown. */
const isPermission = (value: string): value is Permission => /^[^:]+:[^:]+$/.test(value);

/**
 * Declare the admin's OWN permissions (`ADMIN_PERMISSIONS`) and the ones a mount DERIVES —
 * `<entity>:read|write|delete`, a page's, an action's — so `can()` knows them. Granting them stays
 * the app's: a role map that names none of these refuses every screen. Idempotent, and this file's
 * because it is the one that speaks to `@ultimat3/policy`.
 *
 * Called by `defineAdmin()`, never at module scope. The permission registry is permissive while
 * EMPTY and closed once it holds one name, so registering `admin:*` on import closed the set for
 * every module that merely shared a process with this package — an app that imported the admin
 * for a type, and every test file that ran after an admin one.
 */
export function declareAdminPermissions(permissions: readonly string[]): void {
  definePermissions([...ADMIN_PERMISSIONS, ...permissions.filter(isPermission)]);
}

const evaluated = (
  permission: string,
  policy: Policy,
  actor: AdminActor,
  subject: AdminSubject | undefined,
): AdminDecision => {
  // `EvaluateArgs` carries exactly one payload. An admin subject with no action input IS
  // that payload: a row-level rule has nothing but the entity and id to decide on.
  const payload = subject?.input ?? subject;
  // `row` is passed through only when the surface LOADED one. Omitting it and passing
  // `row: undefined` are different facts to `evaluate`, and a rule that reads `row` must see
  // `null` — "no row was loaded" — rather than a value the admin invented from `input`.
  const row = subject === undefined || !('row' in subject) ? undefined : { row: subject.row };
  return readDecision(
    permission,
    evaluate(policy, { actor: policyActor(actor), input: payload, ...row }),
  );
};

/**
 * The default authz: the app's ROLE MAP decides. Every permission the admin asks about is
 * `can(permission)` — "does a role this actor holds grant it" — so an app with a `defineRoles()`
 * call has a working, closed admin with no permission → policy table to keep in step. An app
 * whose rules read the row or the tenant passes `policyAuthz({ policies })` instead.
 */
export function roleAuthz(): AdminAuthz {
  return {
    decide({ permission, actor, subject }): AdminDecision {
      // Asked BEFORE `can()`, which throws on a name the registry lacks: a decision is an answer,
      // and an undeclared permission is a refusal with its fix, never a 500 out of a nav render.
      if (!isPermission(permission) || !isKnownPermission(permission)) {
        return adminDenied(permission, 'admin.policy.missing', [
          `"${permission}" is not a declared resource:verb permission`,
          `fix: definePermissions(['${permission}']), then grant it to a role in defineRoles()`,
        ]);
      }
      // `can()` asserts the name against the registry `declareAdminPermissions` filled. The cast
      // is the same one a route guard's bare string takes: the registry, not the type, is the check.
      const own = evaluated(permission, can(permission as KnownPermission), actor, subject);
      if (own.allowed) return own;
      // The admin's implications, as `staticAuthz` applies them: a role granting `admin:destroy`
      // holds `admin:write` and `admin:read` too. Without this the same grants answered two ways.
      for (const implier of impliersOf(permission)) {
        const carried = evaluated(implier, can(implier as KnownPermission), actor, subject);
        if (carried.allowed) {
          return adminAllowed(permission, carried.reason, [
            ...carried.trace,
            `${permission} is implied by ${implier}`,
          ]);
        }
      }
      return own;
    },
  };
}

/**
 * ONE policy answers every gate the admin asks — "whoever may run the app may run its admin".
 * The shape a small app starts in: a single grant its role map already has, with no table of
 * per-entity permissions to keep in step as entities are added. The pair is still asked
 * (`admin:write` then `posts:write`), each is still audited under its own name, and the day a
 * view-only operator is needed this becomes `roleAuthz()` or `policyAuthz({ policies })`.
 */
export function singlePolicyAuthz(policy: Policy): AdminAuthz {
  return {
    decide: ({ permission, actor, subject }): AdminDecision =>
      evaluated(permission, policy, actor, subject),
  };
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
        return adminDenied(permission, 'admin.policy.missing', [
          `no policy registered for "${permission}"`,
          `fix: definePermissions({ '${permission}': … }) or can('${permission}') on the action`,
        ]);
      }
      return evaluated(permission, policy, actor, subject);
    },
  };
}
