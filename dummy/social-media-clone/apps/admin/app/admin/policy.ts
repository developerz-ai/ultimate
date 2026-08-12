// The admin's authorization, in ONE place. `policyAuthz()` is the only bridge the dashboard has to
// the app's policies, so the rendered button, the HTTP call behind it and the MCP tool all reach
// this table — there is no second door and no per-view check.
//
// The load-bearing line is `admin`'s grant list: it holds `admin:read` and the per-entity `:read`
// permissions, and it holds NOTHING that writes. View-only is therefore a property of the actor's
// permissions, not of which controls a template happened to render.

import { ADMIN_DESTROY, ADMIN_READ, ADMIN_WRITE } from '@ultimat3/admin';
import type { Policy } from '@ultimat3/policy';
import { can, definePermissions, defineRoles, roleDefinitions } from '@ultimat3/policy';

/**
 * Declared, so a typo is a build error rather than a rule that silently never matches. The four
 * `admin:*` names are already declared at runtime by `@ultimat3/admin`'s own policy bridge; they
 * are here because `can()`'s key type reads THIS registry, not that call.
 */
declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'admin:read': true;
    'admin:write': true;
    'admin:destroy': true;
    'users:read': true;
    'users:write': true;
    'users:delete': true;
    'users:suspend': true;
    'posts:read': true;
    'posts:write': true;
    'posts:delete': true;
    'media:read': true;
    'media:write': true;
    'media:delete': true;
    'job:read': true;
    'audit:read': true;
  }
}

/** Every entity the dashboard lists, and the three verbs `entityPermissionFor()` derives. */
const ENTITY_PERMISSIONS = [
  'users:read',
  'users:write',
  'users:delete',
  'posts:read',
  'posts:write',
  'posts:delete',
  'media:read',
  'media:write',
  'media:delete',
] as const;

/** The built-in pages gate on their own subject, not on an entity: jobs and the audit log. */
const PAGE_PERMISSIONS = ['job:read', 'audit:read'] as const;

/** An admin action carries its own permission — `AdminAction.permission` is never optional. */
const ACTION_PERMISSIONS = ['users:suspend'] as const;

export const adminPermissions = definePermissions([
  ADMIN_READ,
  ADMIN_WRITE,
  ADMIN_DESTROY,
  ...ENTITY_PERMISSIONS,
  ...PAGE_PERMISSIONS,
  ...ACTION_PERMISSIONS,
]);

/** Every read the dashboard can ask for. Named once so the two role lists cannot drift apart. */
const READ_GRANTS = [
  ADMIN_READ,
  'users:read',
  'posts:read',
  'media:read',
  'job:read',
  'audit:read',
] as const;

/**
 * Roles, merged onto whatever is already defined rather than replacing it: `defineRoles()` SETS the
 * map, so this module and `apps/web/app/auth/roles.ts` would silently delete each other's roles
 * depending on import order. Merging is the only composable spelling there is.
 *
 * `member` is NOT declared here. It is the web surface's role and its grants are the web surface's
 * permissions; declaring an empty one beside them is what left every signed-in demo user holding
 * nothing at all. This file owns the dashboard's half and inherits the rest.
 *
 * `admin` inherits `member` because the seeded `admin` account is also a person who uses the app —
 * and inheriting cannot leak a write into the dashboard, whose every write gates on `admin:write`.
 *
 * `operator` exists so the refusal above is provably a PERMISSION and not a missing feature: the
 * same code path allows the write when the actor holds `admin:write`. No seeded user can reach it —
 * `USER_ROLES` in @social-media-clone/domain is `member | admin` and nothing else — so it is a test
 * fixture that cannot become a production grant by accident.
 */
export const adminRoles = defineRoles({
  ...roleDefinitions(),
  admin: {
    grants: [...READ_GRANTS],
    inherits: ['member'],
    description: 'the seeded demo operator: sees everything, changes nothing. No admin:write.',
  },
  operator: {
    grants: [
      ADMIN_WRITE,
      ADMIN_DESTROY,
      'users:write',
      'users:delete',
      'users:suspend',
      'posts:write',
      'posts:delete',
      'media:write',
      'media:delete',
    ],
    inherits: ['admin'],
    description: 'a real operator. Unreachable in this app — no seeded user carries this role.',
  },
});

/**
 * Permission → the policy that decides it. `policyAuthz()` is closed by default: a permission with
 * no entry here is DENIED with the fix in its trace, which is the only safe direction for a
 * dashboard. Every rule is `can(...)` with no predicate — the admin's question is "may this actor
 * do this at all", and row-level visibility belongs to the feature's own policy, not to a table.
 */
export const adminPolicies: Readonly<Record<string, Policy>> = Object.freeze(
  Object.fromEntries(adminPermissions.all.map((permission) => [permission, can(permission)])),
);
