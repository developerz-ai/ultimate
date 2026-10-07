// A wildcard grant reaches what its PREFIX names and nothing beside it. `billing:invoice:*` used to
// be read as "every permission on `billing`" — the resource was the text before the FIRST `:` —
// so an actor granted invoices could issue refunds. Each reader of a grant is pinned here: the
// role matcher, the per-actor index `can()` reads, and the `/_x` reverse lookup.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { actorHas } from './grant-index';
import { clearPermissions, definePermissions } from './permissions';
import { clearRoles, defineRoles, grantMatches, rolesGranting } from './roles';

const DECLARED = ['billing:invoice:read', 'billing:refund:issue', 'billing:invoice:*'] as const;

beforeEach(() => {
  clearRoles();
  clearPermissions();
  definePermissions(DECLARED);
});

afterEach(() => {
  clearRoles();
  clearPermissions();
});

describe('a nested wildcard stays inside its prefix', () => {
  test('grantMatches: billing:invoice:* covers invoices, never refunds', () => {
    expect(grantMatches('billing:invoice:*', 'billing:invoice:read')).toBe(true);
    expect(grantMatches('billing:invoice:*', 'billing:refund:issue')).toBe(false);
    expect(grantMatches('billing:invoice:*', 'billing:invoicex:read')).toBe(false);
  });

  test('actorHas, through a role and through a direct permission', () => {
    defineRoles({ clerk: { grants: ['billing:invoice:*'] } });
    const viaRole = userActor({ id: 'u1', roles: ['clerk'] });
    const direct = userActor({ id: 'u2', permissions: ['billing:invoice:*'] });
    for (const actor of [viaRole, direct]) {
      expect(actorHas(actor, 'billing:invoice:read')).toBe(true);
      expect(actorHas(actor, 'billing:refund:issue')).toBe(false);
    }
  });

  test('rolesGranting names only the roles that really reach the permission', () => {
    defineRoles({ clerk: { grants: ['billing:invoice:*'] }, cfo: { grants: ['billing:*'] } });
    expect(rolesGranting('billing:refund:issue')).toEqual(['cfo']);
    expect(rolesGranting('billing:invoice:read')).toEqual(['cfo', 'clerk']);
  });

  test('a one-level wildcard keeps reaching every depth under its resource', () => {
    expect(grantMatches('billing:*', 'billing:refund:issue')).toBe(true);
    expect(grantMatches('post:*', 'post:read')).toBe(true);
    expect(grantMatches('post:*', 'poster:read')).toBe(false);
    expect(grantMatches('*', 'billing:refund:issue')).toBe(true);
  });
});
