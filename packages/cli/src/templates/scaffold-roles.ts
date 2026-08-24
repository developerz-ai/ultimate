// The one place a scaffolded app's roles live, decided rather than left to each feature to invent.
// `defineRoles()` MERGES, so a second call in a feature folder is legal and silent — which is
// exactly why the location has to ship: without a scaffolded file, "where do roles live?" has as
// many answers as the app has folders, and the framework's two tracked apps already disagree.

import type { GeneratedFile } from './naming';

const rolesSource =
  (): string => `// Who holds which permission, for the whole app. Roles are sugar: every one expands to a flat
// permission set before any policy runs, so a rule never reasons about the hierarchy.
//
// ONE file, and it lives in shared/ — the leaf both site/ and app/ already import, and the one the
// boot scan loads, so the map is filled before the first request. \`defineRoles()\` merges into that
// map rather than replacing it, and refuses a role two modules define differently
// (X_ROLE_REDEFINED, naming both declaration sites). A feature that needs a new grant adds it to a
// role HERE; calling defineRoles() again from a feature folder works and is the drift this file
// exists to prevent.
//
// \`x g policy <feature>\` declares \`<feature>:read\` and \`<feature>:write\`. Granting them is this
// file's job — a permission no role holds is one no actor can ever exercise.

import { definePermissions, defineRoles } from '@ultimat3/policy';

// DECLARED before it is granted, and that order is the whole point. \`can()\` calls
// \`assertPermission\`, which refuses a name no \`definePermissions()\` call registered
// (X_PERMISSION_UNKNOWN) — and \`defineRoles()\` does NOT: it took \`grants: ['dashboard:read']\`
// in silence while nothing declared it, so every scaffolded app answered HTTP 500 on /dashboard
// and /admin from its first \`x dev\`, under a green gate. A permission a role grants and a
// permission a route requires both belong here.
export const appPermissions = definePermissions(['admin:read', 'dashboard:read']);

export const roles = defineRoles({
  member: {
    description: 'Signed in. Reads the app surface.',
    grants: ['dashboard:read'],
  },
  admin: {
    description: 'Runs the app: the /admin surface, plus everything a member may do.',
    grants: ['admin:read'],
    inherits: ['member'],
  },
});
`;

const rolesTest =
  (): string => `// The app's role map, expanded: what each role grants once inheritance is flattened, and which
// roles hold a given permission. An undeclared role must grant nothing at all.
import { expandRoles, isKnownPermission, rolesGranting } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { appPermissions, roles } from './roles';

// The map is passed explicitly rather than read off the module-global one: a test that depended on
// which module imported first would pass alone and fail inside a suite.

unitTest('admin inherits every member grant and adds its own', () => {
  expect(expandRoles(['member'], roles)).toEqual(['dashboard:read']);
  expect(expandRoles(['admin'], roles)).toEqual(['admin:read', 'dashboard:read']);
});

unitTest('a role nobody declared grants nothing', () => {
  expect(expandRoles(['visitor'], roles)).toEqual([]);
});

unitTest('every permission the app enforces is held by some role', () => {
  expect(rolesGranting('dashboard:read', roles)).toEqual(['admin', 'member']);
  expect(rolesGranting('admin:read', roles)).toEqual(['admin']);
});

// The assertion whose absence shipped a 500. Expansion above proves the MAP is right and says
// nothing about the registry \`can()\` actually consults: a grant naming a permission no
// \`definePermissions()\` declared expands perfectly and then throws X_PERMISSION_UNKNOWN on the
// first request to the route that requires it.
unitTest('every granted permission is in the registry can() asks', () => {
  for (const permission of new Set(Object.values(roles).flatMap((role) => role.grants))) {
    expect({ permission, known: isKnownPermission(permission) }).toEqual({
      permission,
      known: true,
    });
  }
});

unitTest('the routes this app ships require permissions this app declares', () => {
  // The two \`defineRoute({ policy: { permission } })\` values \`x new\` writes. \`RouteGuard\`
  // keeps a bare string, so nothing but this holds them to the declared set.
  expect(appPermissions.has('dashboard:read')).toBe(true);
  expect(appPermissions.has('admin:read')).toBe(true);
});
`;

/** `apps/web/shared/roles.ts` and its test. Written by `x new`, with or without the example slice. */
export function rolesFiles(): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/roles.ts', contents: rolesSource() },
    { path: 'apps/web/shared/roles.test.ts', contents: rolesTest() },
  ];
}
