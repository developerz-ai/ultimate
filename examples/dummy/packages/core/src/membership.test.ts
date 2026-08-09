/** unit — no DB, no I/O. `memberOf` is the seam every policy predicate starts from. */

import { expect, test } from 'bun:test';
import { memberId, orgId } from '@postly/domain';
import { mayAdministerOrg, mayInvite, mayPublish, memberOf } from './membership';

const ORG = orgId('00000000-0000-4000-8000-000000000002');
const OTHER = orgId('00000000-0000-4000-8000-000000000009');

test('memberOf projects a framework actor onto the membership actor', () => {
  const member = memberOf({ id: 'm1', orgId: ORG, roles: ['admin'] });
  expect(member).toEqual({ memberId: memberId('m1'), orgId: ORG, role: 'admin' });
  // Which is the whole point: the predicates take it verbatim, no cast at the call site.
  expect(member !== null && mayInvite(member, member.orgId)).toBe(true);
  expect(member !== null && mayAdministerOrg(member, member.orgId)).toBe(false);
});

test('memberOf is null for anyone a rule cannot decide about', () => {
  // Each of these used to read as `undefined` off a half-built actor, which a predicate then
  // compared against a real org id — a denial for the wrong reason, or worse.
  expect(memberOf(null)).toBeNull();
  expect(memberOf(undefined)).toBeNull();
  expect(memberOf({ id: 'm1', roles: ['admin'] })).toBeNull(); // no org
  expect(memberOf({ id: 'm1', orgId: null, roles: ['admin'] })).toBeNull();
  expect(memberOf({ id: 'm1', orgId: ORG })).toBeNull(); // no roles at all
  expect(memberOf({ id: 'm1', orgId: ORG, roles: ['billing-contact'] })).toBeNull();
});

test('memberOf keeps the first membership role and ignores unrelated ones', () => {
  // An actor carries every role the app gave it; only the membership vocabulary decides authz.
  const member = memberOf({ id: 'm1', orgId: ORG, roles: ['beta-tester', 'owner', 'reader'] });
  expect(member?.role).toBe('owner');
});

test('a projected actor still cannot reach across orgs', () => {
  const member = memberOf({ id: 'm1', orgId: ORG, roles: ['owner'] });
  expect(member !== null && mayAdministerOrg(member, OTHER)).toBe(false);
  expect(member !== null && mayPublish(member, { orgId: OTHER, authorId: memberId('m1') })).toBe(
    false,
  );
});
