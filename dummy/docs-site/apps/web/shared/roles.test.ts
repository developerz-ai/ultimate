// The app's role map, expanded: what each role grants once inheritance is flattened, and which
// roles hold a given permission. An undeclared role must grant nothing at all.
import { expandRoles, isKnownPermission, rolesGranting } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { appPermissions, roles } from './roles';

// Every feature's policy.ts, imported the way the boot scan imports it: `x g policy` grants the
// permissions a policy.ts DECLARES, so the registry below is only whole once they have run.
const features = new Bun.Glob('{app,site}/*/policy.ts');
for await (const file of features.scan({ cwd: `${import.meta.dir}/..` })) {
  await import(`${import.meta.dir}/../${file}`);
}

// The map is passed explicitly rather than read off the module-global one: a test that depended on
// which module imported first would pass alone and fail inside a suite.

// Subsets, never exact lists: every `x g policy` adds a grant here, and a pinned list would make
// the generator's correct edit a red test.
unitTest('admin inherits every member grant and adds its own', () => {
  const member = expandRoles(['member'], roles);
  const admin = expandRoles(['admin'], roles);
  expect(member).toContain('dashboard:read');
  expect(member).not.toContain('admin:read');
  expect(admin).toContain('admin:read');
  for (const permission of member) expect(admin).toContain(permission);
});

// `admin:read` alone looks; a write needs `admin:write` and a delete `admin:destroy`. The admin
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
// nothing about the registry `can()` actually consults: a grant naming a permission no
// `definePermissions()` declared expands perfectly and then throws X_PERMISSION_UNKNOWN on the
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
  // The two `defineRoute({ policy: { permission } })` values `x new` writes. `RouteGuard`
  // keeps a bare string, so nothing but this holds them to the declared set.
  expect(appPermissions.has('dashboard:read')).toBe(true);
  expect(appPermissions.has('admin:read')).toBe(true);
});
