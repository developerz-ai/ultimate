// Who holds which permission, for the whole app. Roles are sugar: every one expands to a flat
// permission set before any policy runs, so a rule never reasons about the hierarchy.
//
// ONE file, and it lives in shared/ — the leaf both site/ and app/ already import, and the one the
// boot scan loads, so the map is filled before the first request. `defineRoles()` merges into that
// map rather than replacing it, and refuses a role two modules define differently
// (X_ROLE_REDEFINED, naming both declaration sites). A feature that needs a new grant adds it to a
// role HERE; calling defineRoles() again from a feature folder works and is the drift this file
// exists to prevent.
//
// `x g policy <feature>` declares `<feature>:read` and `<feature>:write` and grants them below —
// read to member, write to admin. A permission no role holds is one no actor can ever exercise,
// and `x verify`'s policy step refuses it (X_PERMISSION_UNGRANTED).
//
// The admin at /admin asks TWO permissions per operation: its own gate (`admin:read` to look,
// `admin:write` to create or edit, `admin:destroy` to delete) and the table's
// (`<table>:read|write|delete`); its jobs and audit screens ask `job:read` and `audit:read`. `x g entity` and `x g resource` declare and grant a new table's
// three to `admin` here. A view-only operator is a role holding `admin:read` and each
// `<table>:read` and nothing else: every write is refused by the same decision that hid its button.

import { definePermissions, defineRoles } from '@ultimat3/policy';

// DECLARED before it is granted, and that order is the whole point. `can()` calls
// `assertPermission`, which refuses a name no `definePermissions()` call registered
// (X_PERMISSION_UNKNOWN) — and `defineRoles()` does NOT: it took `grants: ['dashboard:read']`
// in silence while nothing declared it, so every scaffolded app answered HTTP 500 on /dashboard
// and /admin from its first `x dev`, under a green gate. A permission a role grants and a
// permission a route requires both belong here.
export const appPermissions = definePermissions([
  'admin:read',
  'admin:write',
  'admin:destroy',
  'job:read',
  'audit:read',
  'dashboard:read',
]);

export const roles = defineRoles({
  member: {
    description: 'Signed in. Reads the app surface.',
    grants: ['dashboard:read'],
  },
  admin: {
    description: 'Runs the app: the /admin surface, plus everything a member may do.',
    grants: ['admin:read', 'admin:write', 'admin:destroy', 'job:read', 'audit:read'],
    inherits: ['member'],
  },
});
