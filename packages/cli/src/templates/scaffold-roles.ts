// The one place a scaffolded app's roles live, decided rather than left to each feature to invent.
// `defineRoles()` MERGES, so a second call in a feature folder is legal and silent — which is
// exactly why the location has to ship: without a scaffolded file, "where do roles live?" has as
// many answers as the app has folders, and the framework's two tracked apps already disagree.

import type { GeneratedFile } from './naming';
import { wrapList } from './wrap';

/** A role's grants as Biome prints them: one line when it fits, one grant per line when not. */
const grants = (list: readonly string[]): string =>
  wrapList(
    '    ',
    'grants: [',
    list.map((grant) => `'${grant}'`),
    '],',
  );

/** The three gates `@ultimat3/admin` asks before any per-table one — `ADMIN_OPERATION_RULES`. */
const ADMIN_GATES = ['admin:read', 'admin:write', 'admin:destroy'] as const;

/**
 * What the two built-in screens with no table behind them ask beside `admin:read`: `/admin/jobs`
 * and `/admin/audit`. Held by the role that runs the admin, or both links are a 403.
 */
const ADMIN_SCREENS = ['job:read', 'audit:read'] as const;

/**
 * What the admin asks for one table on the handle: `<table>:read|write|delete`. The example slice
 * adds `posts`, so the scaffold writes the grants `x g resource post` would have — the same three
 * `generate-grants.ts` adds for every entity generated later.
 */
const tableGrants = (table: string): readonly string[] =>
  ['read', 'write', 'delete'].map((verb) => `${table}:${verb}`);

const EXAMPLE_TABLE = 'posts';

const rolesSource = (
  example: boolean,
): string => `// Who holds which permission, for the whole app. Roles are sugar: every one expands to a flat
// permission set before any policy runs, so a rule never reasons about the hierarchy.
//
// ONE file, and it lives in shared/ — the leaf both site/ and app/ already import, and the one the
// boot scan loads, so the map is filled before the first request. \`defineRoles()\` merges into that
// map rather than replacing it, and refuses a role two modules define differently
// (X_ROLE_REDEFINED, naming both declaration sites). A feature that needs a new grant adds it to a
// role HERE; calling defineRoles() again from a feature folder works and is the drift this file
// exists to prevent.
//
// \`x g policy <feature>\` declares \`<feature>:read\` and \`<feature>:write\` and grants them below —
// read to member, write to admin. A permission no role holds is one no actor can ever exercise,
// and \`x verify\`'s policy step refuses it (X_PERMISSION_UNGRANTED).
//
// The admin at /admin asks TWO permissions per operation: its own gate (\`admin:read\` to look,
// \`admin:write\` to create or edit, \`admin:destroy\` to delete) and the table's
// (\`<table>:read|write|delete\`); its jobs and audit screens ask \`job:read\` and \`audit:read\`. \`x g entity\` and \`x g resource\` declare and grant a new table's
// three to \`admin\` here. A view-only operator is a role holding \`admin:read\` and each
// \`<table>:read\` and nothing else: every write is refused by the same decision that hid its button.

import { definePermissions, defineRoles } from '@ultimat3/policy';

// DECLARED before it is granted, and that order is the whole point. \`can()\` calls
// \`assertPermission\`, which refuses a name no \`definePermissions()\` call registered
// (X_PERMISSION_UNKNOWN) — and \`defineRoles()\` does NOT: it took \`grants: ['dashboard:read']\`
// in silence while nothing declared it, so every scaffolded app answered HTTP 500 on /dashboard
// and /admin from its first \`x dev\`, under a green gate. A permission a role grants and a
// permission a route requires both belong here.
${wrapList(
  '',
  'export const appPermissions = definePermissions([',
  [
    ...ADMIN_GATES,
    ...ADMIN_SCREENS,
    'dashboard:read',
    ...(example ? tableGrants(EXAMPLE_TABLE) : []),
  ].map((permission) => `'${permission}'`),
  ']);',
)}

export const roles = defineRoles({
  member: {
    description: 'Signed in. Reads the app surface.',
${grants(['dashboard:read', ...(example ? ['post:read'] : [])])}
  },
  admin: {
    description: 'Runs the app: the /admin surface, plus everything a member may do.',
${grants([
  ...ADMIN_GATES,
  ...ADMIN_SCREENS,
  ...(example ? ['post:write', ...tableGrants(EXAMPLE_TABLE)] : []),
])}
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

// Every feature's policy.ts, imported the way the boot scan imports it: \`x g policy\` grants the
// permissions a policy.ts DECLARES, so the registry below is only whole once they have run.
const features = new Bun.Glob('{app,site}/*/policy.ts');
for await (const file of features.scan({ cwd: \`\${import.meta.dir}/..\` })) {
  await import(\`\${import.meta.dir}/../\${file}\`);
}

// The map is passed explicitly rather than read off the module-global one: a test that depended on
// which module imported first would pass alone and fail inside a suite.

// Subsets, never exact lists: every \`x g policy\` adds a grant here, and a pinned list would make
// the generator's correct edit a red test.
unitTest('admin inherits every member grant and adds its own', () => {
  const member = expandRoles(['member'], roles);
  const admin = expandRoles(['admin'], roles);
  expect(member).toContain('dashboard:read');
  expect(member).not.toContain('admin:read');
  expect(admin).toContain('admin:read');
  for (const permission of member) expect(admin).toContain(permission);
});

// \`admin:read\` alone looks; a write needs \`admin:write\` and a delete \`admin:destroy\`. The admin
// role holds all three, and a member none — so "view-only" is a role, never a mode.
unitTest('the admin role holds all three admin gates, and a member none of them', () => {
  const admin = expandRoles(['admin'], roles);
  const member = expandRoles(['member'], roles);
  for (const gate of ['admin:read', 'admin:write', 'admin:destroy']) {
    expect(admin).toContain(gate);
    expect(member).not.toContain(gate);
  }
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
export function rolesFiles(example = false): readonly GeneratedFile[] {
  return [
    { path: 'apps/web/shared/roles.ts', contents: rolesSource(example) },
    { path: 'apps/web/shared/roles.test.ts', contents: rolesTest() },
  ];
}
