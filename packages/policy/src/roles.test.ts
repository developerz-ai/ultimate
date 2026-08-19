// `roles.ts` expands role hierarchies to flat permission sets before any policy runs.
// policy.test.ts exercises `expandRoles`/`actorHas` end-to-end through `can()`; these tests
// cover the exports that only get indirect coverage there: `roleDefinitions()`,
// `actorPermissions()`, `grantMatches()` called directly, and `rolesGranting()`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { actorHas, actorPermissions } from './grant-index';
import {
  clearRoles,
  defineRoles,
  expandRoles,
  grantMatches,
  type RoleDef,
  type RoleMap,
  restoreRoles,
  roleDeclarationSites,
  roleDefinitions,
  roleMapGeneration,
  rolesGranting,
} from './roles';

const roles: RoleMap = {
  viewer: { grants: ['post:read'] },
  editor: { grants: ['post:publish'], inherits: ['viewer'] },
  owner: { grants: ['post:delete'], inherits: ['editor'] },
  mod: { grants: ['post:*'] },
  root: { grants: ['*'] },
};

// The registry is process-global — every test hands it back the way it found it.
beforeEach(() => {
  clearRoles();
});

afterEach(() => {
  clearRoles();
});

describe('defineRoles() / roleDefinitions()', () => {
  test('roleDefinitions() reads back exactly what defineRoles() set', () => {
    defineRoles(roles);
    expect(roleDefinitions()).toEqual(roles);
  });

  test('defineRoles() returns the map it was given, for chaining at the call site', () => {
    expect(defineRoles(roles)).toBe(roles);
  });

  test('clearRoles() empties the registry', () => {
    defineRoles(roles);
    clearRoles();
    expect(roleDefinitions()).toEqual({});
    expect(expandRoles(['owner'])).toEqual([]);
  });

  // The regression: `defineRoles()` used to REPLACE. A second call in a new feature folder
  // deleted the first module's roles, every `can()` still typechecked, and every request 403'd
  // on whichever import order the bundler picked.
  test('a second defineRoles() never deletes the first module’s roles', () => {
    defineRoles({ viewer: { grants: ['post:read'] } });
    defineRoles({ member: { grants: ['comment:write'] } });
    expect(Object.keys(roleDefinitions()).sort()).toEqual(['member', 'viewer']);
    expect(expandRoles(['viewer'])).toEqual(['post:read']);
  });

  test('redefining a role with different grants throws X_ROLE_REDEFINED, naming both sites', () => {
    defineRoles({ member: { grants: ['comment:write'] } });
    let thrown: unknown;
    try {
      defineRoles({ member: { grants: ['comment:write', 'post:delete'] } });
    } catch (error) {
      thrown = error;
    }
    const rendered = String(thrown);
    expect(rendered).toContain('X_ROLE_REDEFINED');
    expect(rendered).toContain('member');
    expect(rendered).toContain('roles.test.ts');
  });

  // The spelling both tracked apps already use to work around the replace. It must stay legal.
  test('re-declaring a role identically is a no-op, spread included', () => {
    defineRoles({ viewer: { grants: ['post:read'] } });
    expect(() =>
      defineRoles({ ...roleDefinitions(), member: { grants: ['comment:write'] } }),
    ).not.toThrow();
    // Same content, a different object and a different grant order: still the same role.
    expect(() => defineRoles({ viewer: { grants: ['post:read'] } })).not.toThrow();
    expect(Object.keys(roleDefinitions()).sort()).toEqual(['member', 'viewer']);
  });

  test('roleMapGeneration() bumps on every write, so a memo cannot go stale', () => {
    const start = roleMapGeneration();
    defineRoles({ viewer: { grants: ['post:read'] } });
    expect(roleMapGeneration()).toBeGreaterThan(start);
    const afterDefine = roleMapGeneration();
    clearRoles();
    expect(roleMapGeneration()).toBeGreaterThan(afterDefine);
  });
});

describe('grantMatches()', () => {
  test('an exact grant matches only the same permission', () => {
    expect(grantMatches('post:read', 'post:read')).toBe(true);
    expect(grantMatches('post:read', 'post:publish')).toBe(false);
  });

  test('a resource wildcard matches every verb on that resource, no other resource', () => {
    expect(grantMatches('post:*', 'post:read')).toBe(true);
    expect(grantMatches('post:*', 'post:delete')).toBe(true);
    expect(grantMatches('post:*', 'org:admin')).toBe(false);
  });

  test('the global wildcard matches anything', () => {
    expect(grantMatches('*', 'post:read')).toBe(true);
    expect(grantMatches('*', 'anything:at-all')).toBe(true);
  });

  test('a malformed grant matches nothing but an exact string equal to itself', () => {
    expect(grantMatches('not-a-grant', 'not-a-grant')).toBe(true);
    expect(grantMatches('not-a-grant', 'post:read')).toBe(false);
  });
});

describe('actorPermissions()', () => {
  beforeEach(() => {
    defineRoles(roles);
  });

  test('a null actor has no permissions', () => {
    expect(actorPermissions(null)).toEqual([]);
  });

  test('combines direct grants with role-derived ones, deduped and sorted', () => {
    const actor = { id: 'u1', roles: ['viewer'], permissions: ['post:read', 'comment:write'] };
    expect(actorPermissions(actor)).toEqual(['comment:write', 'post:read']);
  });

  test('an actor with no roles or direct grants has none', () => {
    const actor = { id: 'u1' };
    expect(actorPermissions(actor)).toEqual([]);
  });

  test('accepts an explicit map override instead of the global registry', () => {
    const localMap: RoleMap = { local: { grants: ['x:y'] } };
    const actor = { id: 'u1', roles: ['local'] };
    expect(actorPermissions(actor, localMap)).toEqual(['x:y']);
    // The global registry (defineRoles(roles) in beforeEach) has no `local` role.
    expect(actorPermissions(actor)).toEqual([]);
  });
});

describe('actorHas()', () => {
  beforeEach(() => {
    defineRoles(roles);
  });

  test('true when a role grant (direct or wildcard) covers the permission', () => {
    const modActor = { id: 'm1', roles: ['mod'] };
    expect(actorHas(modActor, 'post:delete')).toBe(true);
    expect(actorHas(modActor, 'org:admin')).toBe(false);
  });

  test('a null actor never has any permission', () => {
    expect(actorHas(null, 'post:read')).toBe(false);
  });
});

describe('rolesGranting()', () => {
  beforeEach(() => {
    defineRoles(roles);
  });

  test('lists every role (direct or inherited) that would satisfy a permission, sorted', () => {
    expect(rolesGranting('post:read')).toEqual(['editor', 'mod', 'owner', 'root', 'viewer']);
  });

  test('a permission nothing grants returns an empty list', () => {
    // `defineRoles()` merges, so the map has to be emptied to be narrowed.
    clearRoles();
    defineRoles({ viewer: { grants: ['post:read'] } });
    expect(rolesGranting('billing:refund')).toEqual([]);
  });

  test('accepts an explicit map override instead of the global registry', () => {
    const localMap: RoleMap = { local: { grants: ['x:y'] } };
    expect(rolesGranting('x:y', localMap)).toEqual(['local']);
    // The global registry (defineRoles(roles) in beforeEach) has no `local` role and no
    // grant matching `x:y` other than root's `*`, which is asserted separately above.
    clearRoles();
    expect(rolesGranting('x:y')).toEqual([]);
  });
});

describe('restoreRoles()', () => {
  // Same one-way hazard as `clearPermissions()`: `defineRoles()` runs at an app's MODULE scope,
  // and a module evaluates once per `bun test` process, so a `clearRoles()` in one test file is
  // permanent for every file after it — a later `import` is a cache hit that declares nothing.
  test('puts back a map clearRoles destroyed, which re-importing cannot', () => {
    defineRoles(roles);
    const captured = roleDefinitions();
    const capturedSites = roleDeclarationSites();

    clearRoles();
    expect(roleDefinitions()).toEqual({});

    restoreRoles(captured, capturedSites);

    expect(roleDefinitions()).toEqual(roles);
    expect(expandRoles(['editor'])).toEqual(['post:publish', 'post:read']);
  });

  // `defineRoles()` cannot be the restore: it re-derives the declaration site from the CALLER's
  // stack, so every role would report the harness as its origin and X_ROLE_REDEFINED would name
  // a frame no reader can act on.
  test('keeps each role declared where it was actually declared', () => {
    defineRoles({ viewer: roles['viewer'] as RoleDef });
    const captured = roleDefinitions();
    const capturedSites = roleDeclarationSites();
    expect(capturedSites['viewer']).toContain('roles.test.ts');

    clearRoles();
    restoreRoles(captured, capturedSites);

    expect(roleDeclarationSites()['viewer']).toBe(capturedSites['viewer'] as string);
  });

  // The memo in `grant-index.ts` is invalidated by the generation alone, so a restore that did
  // not bump it would leave a flattened grant set computed against the cleared map.
  test('bumps the generation, or the grant memo answers from the map it just replaced', () => {
    defineRoles(roles);
    const captured = roleDefinitions();

    clearRoles();
    // Read AFTER the clear: `clearRoles()` bumps too, so a baseline taken before it passes on a
    // `restoreRoles` that never bumps at all.
    const before = roleMapGeneration();
    restoreRoles(captured, roleDeclarationSites());

    expect(roleMapGeneration()).toBeGreaterThan(before);
    expect(actorPermissions({ id: 'u1', roles: ['editor'] })).toEqual([
      'post:publish',
      'post:read',
    ]);
  });
});
