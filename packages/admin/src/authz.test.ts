// The one authz seam, at its two edges: a list with nothing in it, and a permission name that
// collides with `Object.prototype`.

import { describe, expect, test } from 'bun:test';
import type { AdminActor, AdminAuthz, AdminAuthzQuery } from './authz';
import { allowed, decideAll, expandPermissions, isAllowed } from './authz';

const actor: AdminActor = { id: 'u_1', roles: ['owner'] };

/** Grants everything, so a refusal in these tests can only have come from `decideAll` itself. */
const permissive: AdminAuthz = {
  decide: (query: AdminAuthzQuery) => allowed(query.permission, 'test.granted'),
};

describe('an empty permission list is a gate nobody wrote', () => {
  /**
   * `const last = permissions[permissions.length - 1] ?? ''` then `allowed(last, …)` answered
   * ALLOWED for `[]`, with an empty string as the permission it claimed to have checked. Reachable:
   * `visibleNav` passes an author's `item.permissions` straight through, so a nav item declaring
   * `permissions: []` rendered for every actor, anonymous included. `pages.ts` already refuses an
   * empty page permission list at declaration time (`X_ADMIN_PAGE_UNGUARDED`) — this is the same
   * rule, one layer down, where the surfaces that do NOT go through `defineAdmin` land.
   */
  test('decideAll refuses an empty list rather than granting it', () => {
    const decision = decideAll(permissive, [], actor);
    expect(decision.allowed).toBe(false);
    expect(decision.permission).toBe('');
    expect(decision.reason).toBe('admin.policy.none-declared');
    // The trace says which of the two things happened, because "denied ()" reads like a bug.
    expect(decision.trace.join(' ')).toContain('no permission');
  });

  test('isAllowed answers false for it too — the seam is shared, not restated', () => {
    expect(isAllowed(permissive, [], actor)).toBe(false);
  });

  test('a non-empty list still decides normally', () => {
    const decision = decideAll(permissive, ['admin:read', 'post:read'], actor);
    expect(decision.allowed).toBe(true);
    expect(decision.permission).toBe('post:read');
  });
});

describe('a permission name is looked up as an OWN key of the spec table', () => {
  /**
   * `ADMIN_PERMISSION_SPEC[permission as AdminPermission]` is an index read on a plain object, so
   * it consults the prototype chain — and `expandPermissions` walks whatever `implies` it finds.
   * An app that merges untrusted JSON into an object (the ordinary prototype-pollution shape) can
   * therefore make ANY granted permission imply `admin:destroy`, without the spec table naming it.
   * The cast is the tell: `permission` is a plain `string` at runtime and the table is closed.
   */
  test('a poisoned Object.prototype cannot inject an implication', () => {
    const polluted = Object.prototype as unknown as Record<string, { implies: string[] }>;
    Object.defineProperty(Object.prototype, 'post:read', {
      value: { implies: ['admin:destroy'] },
      configurable: true,
    });
    try {
      expect(expandPermissions(['post:read'])).toEqual(['post:read']);
    } finally {
      delete polluted['post:read'];
    }
  });

  test('a real permission still expands transitively', () => {
    expect(expandPermissions(['admin:destroy'])).toContain('admin:read');
  });
});
