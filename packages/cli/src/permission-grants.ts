// The `policy` step's second question: every permission an action, a query, a route or a MOUNTED
// screen (the admin's) REQUIRES is one some role GRANTS. `x g resource customer` declared `customer:read`/`customer:write`, the
// actions required them, no role held them, and `x verify` was green over an app whose every
// generated endpoint answered 403 to the dev actor (plan 101 slice 11 a).

import { listActions } from '@ultimat3/action';
import type { Policy } from '@ultimat3/policy';
import { roleDefinitions, rolesGranting } from '@ultimat3/policy';
import { listQueries } from '@ultimat3/query';
import { describePages, routeEntries } from '@ultimat3/render';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** One rule that cannot pass for any actor the role map mints. */
export interface UngrantedRequirement {
  readonly permission: string;
  /** `action createCustomer`, `query customerList`, the route file, or a mounted route's URL. */
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
  // A route a package MOUNTED — the admin's — is in no file and so in no `routeEntries()` row. Its
  // screen decides on every permission of the mount, not only the coarse gate its route config
  // carries, so each one is a requirement: a hand-written entity nobody granted `<table>:read`
  // for was a green gate and a 403 on its first open. `describePages()` is memoized by the
  // registry, so this loop reads a list every other step already built.
  // One requirement per permission per mount, naming the first route that asks it: `posts:write`
  // gates the create form and the edit form, and one missing grant is one finding.
  const asked = new Map<string, { permission: string; by: string; first: string; more: number }>();
  for (const route of describePages()) {
    if (route.mount === undefined) continue;
    for (const permission of route.mount.permissions) {
      const key = `${route.mount.by} ${permission}`;
      const held = asked.get(key);
      if (held === undefined) {
        asked.set(key, { permission, by: route.mount.by, first: route.path, more: 0 });
      } else held.more += 1;
    }
  }
  for (const { permission, by, first, more } of asked.values()) {
    const rest = more === 0 ? '' : `, and ${String(more)} more of its routes`;
    rules.push({ permission, by: `${first} (mounted by ${by}${rest})` });
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

/**
 * Where the SCAFFOLD keeps the role map — the file `x g policy` and `x g resource` edit. Never what
 * a finding names: an app may declare its roles anywhere (the reference app's are in
 * `shared/policies.ts`), so `ungrantedFinding` takes the file the role map was declared in.
 */
export const ROLES_FILE = 'apps/web/shared/roles.ts';

/**
 * `rolesAt` is the app-relative file `defineRoles` ran in (`app-permissions.ts`'s `roleMapFile`),
 * or `undefined` when no site under the app root can be read — then the fix names the call, not a
 * path this function would have to guess.
 */
export function ungrantedFinding(rule: UngrantedRequirement, rolesAt: string | undefined): Finding {
  const where = rolesAt ?? 'the module that calls defineRoles({ ... })';
  const finding: Finding = {
    code: 'X_PERMISSION_UNGRANTED',
    cause: `${rule.by} requires ${quoteArg(rule.permission)}, and no role in the app's role map grants it — no actor a role mints can ever pass`,
    fix: `add '${rule.permission}' to the grants of a role in ${where}, then x verify --only policy`,
  };
  return rolesAt === undefined ? finding : { ...finding, at: rolesAt };
}
