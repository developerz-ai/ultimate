// The default actor: whoever the HTTP pipeline resolved for this request, read off core's request
// context. Three facts must survive the crossing — the tenant, the locale and the zone — and
// "nobody" must be `null`, never an actor with an empty id.

import { describe, expect, test } from 'bun:test';
import { anonymousActor, createContext, runWithContext, userActor } from '@ultimat3/core';
import { ANONYMOUS_ADMIN_ACTOR, adminActorFrom, NO_REQUEST_ID, requestActor } from './actor';

describe('unit · adminActorFrom', () => {
  test('an anonymous actor is null — a refusal, not an actor with no roles', () => {
    expect(adminActorFrom(anonymousActor(), 'en', 'UTC')).toBeNull();
  });

  test('id, roles, locale and zone cross; the tenant rides along when there is one', () => {
    const actor = userActor({ id: 'u_1', roles: ['admin'], orgId: 'org_9' });
    expect(adminActorFrom(actor, 'es', 'Europe/Madrid')).toEqual({
      id: 'u_1',
      roles: ['admin'],
      locale: 'es',
      timeZone: 'Europe/Madrid',
      orgId: 'org_9',
    });
  });

  test('a single-tenant actor carries NO orgId key, rather than an undefined one', () => {
    const made = adminActorFrom(userActor({ id: 'u_1', roles: [] }), 'en', 'UTC');
    expect(made === null ? [] : Object.keys(made)).not.toContain('orgId');
  });
});

describe('unit · requestActor', () => {
  test('with no request in flight it is anonymous, under a fixed request id — not a crash', () => {
    expect(requestActor()).toEqual({ actor: null, requestId: NO_REQUEST_ID });
  });

  test('inside a request it is that request’s actor, locale, zone and id', async () => {
    const context = createContext({
      actor: userActor({ id: 'u_7', roles: ['ops'], orgId: 'org_1' }),
      locale: 'de',
      tz: 'Europe/Berlin',
    });
    const seen = await runWithContext(context, async () => requestActor());
    expect(seen.actor).toEqual({
      id: 'u_7',
      roles: ['ops'],
      locale: 'de',
      timeZone: 'Europe/Berlin',
      orgId: 'org_1',
    });
    expect(seen.requestId).toBe(context.requestId);
  });

  test('the anonymous stand-in a decision is asked with has an id and holds nothing', () => {
    expect(ANONYMOUS_ADMIN_ACTOR).toEqual({ id: 'anonymous', roles: [] });
    expect(Object.isFrozen(ANONYMOUS_ADMIN_ACTOR)).toBe(true);
  });
});
