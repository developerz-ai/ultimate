/**
 * The app half of the actor, and the failure it must not hide: a request whose actor carries no
 * member row is an error with a name, never a half-built object a heading reads `undefined` off.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext, userActor } from '@ultimat3/core';
import type { MemberView, OrgView } from '../app/orgs/entity';
import { postlyActor, useActor } from './actor';

const org: OrgView = {
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  planCode: 'team',
  billingCurrency: 'USD',
  seats: 10,
  seatsUsed: 3,
};

const member: MemberView = {
  id: '00000000-0000-4000-8000-000000000002',
  orgId: org.id,
  email: 'ada@acme.example',
  name: 'Ada',
  role: 'author',
  tz: 'Europe/Berlin',
  locale: 'en',
  theme: 'system',
  digestOptIn: true,
};

describe('useActor', () => {
  test('refuses an actor nobody resolved facts for, by code', () => {
    const ctx = createContext({ actor: userActor({ id: member.id, orgId: org.id }) });

    expect(() => runWithContext(ctx, useActor)).toThrow(/X_ACTOR_UNRESOLVED/);
  });

  test('refuses an anonymous actor the same way — the app surface has no member row either', () => {
    expect(() => runWithContext(createContext(), useActor)).toThrow(/X_ACTOR_UNRESOLVED/);
  });

  test('answers the member and org the request actor carries', () => {
    const ctx = createContext({ actor: postlyActor({ member, org }) });

    const actor = runWithContext(ctx, useActor);

    expect(actor.id).toBe(member.id);
    expect(actor.orgId).toBe(org.id);
    expect(actor.member).toEqual(member);
    expect(actor.org).toEqual(org);
  });

  test('takes `now` from the request clock, not the wall clock', () => {
    const fixed = new Date('2026-08-16T09:00:00.000Z');
    const ctx = createContext({
      actor: postlyActor({ member, org }),
      clock: { now: () => fixed, monotonic: () => 0 },
    });

    expect(runWithContext(ctx, useActor).now).toEqual(fixed);
  });
});

describe('postlyActor', () => {
  /** The membership role IS the authz role — `@ultimat3/policy` expands `roles`, with no mapping. */
  test('carries the membership role as the actor role, and the org as the tenant', () => {
    const actor = postlyActor({ member, org });

    expect(actor.roles).toEqual([member.role]);
    expect(actor.orgId).toBe(org.id);
    expect(actor.id).toBe(member.id);
  });
});
