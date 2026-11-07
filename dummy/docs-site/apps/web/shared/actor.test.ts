// `holds` answers from the declared role map, never from a role NAME. An undeclared role must
// expand to no grants — the branch that turns a typo into an actor who can do everything.
import { expect, unitTest } from '@ultimat3/testing';
import type { Actor } from './actor';
import { holds } from './actor';

const actor = (...names: readonly string[]): Actor => ({ id: 'a', orgId: 'o', roles: names });

unitTest('holds answers from the role map, and an anonymous actor holds nothing', () => {
  expect(holds(null, 'dashboard:read')).toBe(false);
  // A role no defineRoles() call declares expands to no grants — never to every grant.
  expect(holds(actor('visitor'), 'dashboard:read')).toBe(false);
  expect(holds(actor('member'), 'dashboard:read')).toBe(true);
  expect(holds(actor('admin'), 'dashboard:read')).toBe(true);
  expect(holds(actor('member'), 'admin:read')).toBe(false);
});
