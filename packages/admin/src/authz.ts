// ONE authz seam for the whole admin. Every surface — the rendered button, the HTTP call
// behind it, the MCP tool, the nav item, the search result — asks this interface and nobody
// re-implements the question. That is the invariant the admin exists to keep: the UI cannot
// show what the call would refuse.
//
// The interface is structural on purpose: `policyAuthz()` in policy-bridge.ts adapts
// @ultimat3/policy into it, a host app can supply its own, and tests can supply a stub —
// but there is still exactly one decision per request.

import { ADMIN_PERMISSION_SPEC, type AdminPermission } from './permissions';

export interface AdminActor {
  readonly id: string;
  /**
   * The tenant this operator acts under. NOT optional in practice on a multi-tenant app: the
   * admin's subject reached `policyAuthz` with `orgId: undefined`, so an org-scoped rule could
   * not fire and a role-only rule allowed — while `adminList`/`adminSearch` add no tenant
   * predicate of their own. Absent still means "single-tenant app", which is why the type keeps
   * it optional; a rule that reads it must fail closed on `undefined` like any other policy.
   */
  readonly orgId?: string;
  readonly roles?: readonly string[];
  /** BCP-47. Drives every `t()` call and every `Intl` format in the admin. */
  readonly locale?: string;
  /** IANA zone. The admin refuses to render a timestamp without one. */
  readonly timeZone?: string;
}

/** What a decision is about: an entity row, an action's input, or nothing (a page). */
export interface AdminSubject {
  readonly entity?: string;
  readonly id?: string;
  readonly input?: unknown;
  /**
   * The already-loaded row, for a row-level rule. `null` means "no row was loaded", which the
   * policy layer treats as no evidence of permission — same contract as an `action`'s `row:`
   * loader. Absent entirely means the surface has no row to load (a list page, a create form).
   *
   * Without it every admin decision evaluated with `row: null` and `input = { entity, id }`, so
   * an ownership rule could not fire at all and the coarse `admin:read` + `<entity>:read` pair
   * was the only gate on a single row.
   */
  readonly row?: unknown;
}

export interface AdminDecision {
  readonly allowed: boolean;
  readonly permission: string;
  /** An i18n key or a policy rule name — never a sentence. Rendered by the caller. */
  readonly reason: string;
  /** Rule-by-rule trace, shown verbatim in the `/_x` policy panel. */
  readonly trace: readonly string[];
}

export interface AdminAuthzQuery {
  readonly permission: string;
  readonly actor: AdminActor;
  readonly subject?: AdminSubject;
}

export interface AdminAuthz {
  decide(query: AdminAuthzQuery): AdminDecision;
}

export function allowed(
  permission: string,
  reason: string,
  trace: readonly string[] = [],
): AdminDecision {
  return { allowed: true, permission, reason, trace };
}

export function denied(
  permission: string,
  reason: string,
  trace: readonly string[] = [],
): AdminDecision {
  return { allowed: false, permission, reason, trace };
}

/** Every permission must hold. The first denial wins, and carries its own reason. */
export function decideAll(
  authz: AdminAuthz,
  permissions: readonly string[],
  actor: AdminActor,
  subject?: AdminSubject,
): AdminDecision {
  const trace: string[] = [];
  for (const permission of permissions) {
    const decision = authz.decide(
      subject === undefined ? { permission, actor } : { permission, actor, subject },
    );
    trace.push(`${permission}: ${decision.allowed ? 'allow' : 'deny'} (${decision.reason})`);
    if (!decision.allowed)
      return denied(permission, decision.reason, [...trace, ...decision.trace]);
  }
  const last = permissions[permissions.length - 1] ?? '';
  return allowed(last, 'admin.policy.all-granted', trace);
}

export function isAllowed(
  authz: AdminAuthz,
  permissions: readonly string[],
  actor: AdminActor,
  subject?: AdminSubject,
): boolean {
  return decideAll(authz, permissions, actor, subject).allowed;
}

const impliedBy = (permission: string): readonly string[] => {
  // Widened: `permission` is any string at runtime, so the lookup really can miss.
  const spec: { readonly implies: readonly string[] } | undefined =
    ADMIN_PERMISSION_SPEC[permission as AdminPermission];
  return spec?.implies ?? [];
};

/** Transitive closure of the admin permission implications (`destroy` ⇒ `write` ⇒ `read`). */
export function expandPermissions(granted: readonly string[]): readonly string[] {
  const out = new Set<string>();
  const walk = (permission: string): void => {
    if (out.has(permission)) return;
    out.add(permission);
    for (const next of impliedBy(permission)) walk(next);
  };
  for (const permission of granted) walk(permission);
  return [...out].sort();
}

/**
 * A grant-list authz for tests, seeds, and `x dev --actor`. Production always goes through
 * `policyAuthz()` so the app's real rules (ownership, org scoping) are the ones evaluated.
 */
export function staticAuthz(granted: readonly string[]): AdminAuthz {
  const set = new Set(expandPermissions(granted));
  return {
    decide({ permission }): AdminDecision {
      return set.has(permission)
        ? allowed(permission, 'admin.policy.granted', [`static: ${permission} in grant list`])
        : denied(permission, 'admin.policy.not-granted', [
            `static: ${permission} not in [${[...set].join(', ')}]`,
          ]);
    },
  };
}

/** No actor, no grants. The default for an unauthenticated request. */
export const anonymousAuthz: AdminAuthz = staticAuthz([]);
