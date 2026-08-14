// `roles.ts` expands role hierarchies to flat permission sets before any policy runs.
// policy.test.ts exercises `expandRoles`/`actorHas` end-to-end through `can()`; these tests
// cover the exports that only get indirect coverage there: `roleDefinitions()`,
// `actorPermissions()`, `grantMatches()` called directly, and `rolesGranting()`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  actorHas,
  actorPermissions,
  clearRoles,
  defineRoles,
  expandRoles,
  grantMatches,
  type RoleMap,
  roleDefinitions,
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
