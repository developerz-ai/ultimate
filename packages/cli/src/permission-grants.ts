// The `policy` step's second question: every permission an action, a query or a route REQUIRES is
// one some role GRANTS. `x g resource customer` declared `customer:read`/`customer:write`, the
// actions required them, no role held them, and `x verify` was green over an app whose every
// generated endpoint answered 403 to the dev actor (plan 101 slice 11 a).

import { listActions } from '@ultimat3/action';
import type { Policy } from '@ultimat3/policy';
import { roleDefinitions, rolesGranting } from '@ultimat3/policy';
import { listQueries } from '@ultimat3/query';
import { routeEntries } from '@ultimat3/render';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** One rule that cannot pass for any actor the role map mints. */
export interface UngrantedRequirement {
  readonly permission: string;
  /** `action createCustomer`, `query customerList`, or the route file. */
  readonly by: string;
}

/**
 * A rule that REQUIRES exactly one permission: a bare `can()`. A composite is not judged — in an
 * `or(...)` one branch may be granted and the other deliberately not, and a `not(...)` names a
 * permission the actor must LACK — so a finding there would be an argument, not a fact.
 */
const required = (policy: Policy<unknown, unknown>): string | undefined =>
  policy.kind === 'permission' && policy.permissions.length === 1
    ? policy.permissions[0]
    : undefined;

/** Every single-permission rule the app's actions, queries and routes declare. */
export function requirements(): readonly UngrantedRequirement[] {
  const rules: UngrantedRequirement[] = [];
  for (const target of listActions()) {
    const permission = required(target.policy);
    if (permission !== undefined) rules.push({ permission, by: `action ${target.name}` });
  }
  for (const target of listQueries()) {
    const permission = required(target.policy);
    if (permission !== undefined) rules.push({ permission, by: `query ${target.name}` });
  }
  for (const entry of routeEntries()) {
    const permission = entry.config.policy?.permission;
    if (permission !== undefined) rules.push({ permission, by: entry.file });
  }
  return rules;
}

/**
 * The requirements no role grants. `rolesGranting` is `@ultimat3/policy`'s own matcher, wildcards
 * included, so the gate and `can()` agree on what a grant covers. An app that declares no role at
 * all is not judged: it grants through `Actor.permissions` directly (an API key, a service actor),
 * and there is no role map for a grant to be missing from.
 */
export function ungrantedRequirements(
  rules: readonly UngrantedRequirement[] = requirements(),
): readonly UngrantedRequirement[] {
  const roles = roleDefinitions();
  if (Object.keys(roles).length === 0) return [];
  const seen = new Set<string>();
  return rules
    .filter((rule) => rolesGranting(rule.permission, roles).length === 0)
    .filter((rule) => {
      const key = `${rule.permission} ${rule.by}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      a.permission === b.permission
        ? a.by.localeCompare(b.by)
        : a.permission.localeCompare(b.permission),
    );
}

/** Where the scaffold keeps the role map — the file `x g policy` and `x g resource` edit. */
export const ROLES_FILE = 'apps/web/shared/roles.ts';

export function ungrantedFinding(rule: UngrantedRequirement): Finding {
  return {
    code: 'X_PERMISSION_UNGRANTED',
    cause: `${rule.by} requires ${quoteArg(rule.permission)}, and no role in the app's role map grants it — no actor a role mints can ever pass`,
    fix: `add '${rule.permission}' to the grants of a role in ${ROLES_FILE}, then x verify --only policy`,
    at: ROLES_FILE,
  };
}
