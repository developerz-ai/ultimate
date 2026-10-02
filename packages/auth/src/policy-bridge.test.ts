// Direct coverage for the single funnel from identity to `Actor` — untested until now despite
// being the one place every ActorKind gets minted, including the MFA-pending narrowing that
// silently strips roles/permissions instead of throwing.

import { describe, expect, test } from 'bun:test';
import type { AuthApiKeyRecord, AuthSession, AuthUser } from './adapter';
import {
  actorFromApiKey,
  actorFromService,
  actorFromUser,
  apiKeyScopes,
  resolveActor,
  type ServiceIdentity,
} from './policy-bridge';

const USER: AuthUser = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerifiedAt: new Date(0),
  passwordHash: 'hash',
  orgId: 'org-1',
  roles: ['editor'],
  permissions: ['posts:archive'],
  scopes: ['tenancy:cross'],
  mfaSecret: null,
  recoveryCodeHashes: [],
  externalId: null,
  disabledAt: null,
  createdAt: new Date(0),
};

const SESSION: AuthSession = {
  id: 'sess-1',
  userId: 'user-1',
  tokenHash: 'th',
  createdAt: new Date(0),
  absoluteExpiresAt: new Date(1_000),
  lastSeenAt: new Date(0),
  ip: null,
  userAgent: null,
  mfaSatisfied: true,
};

const API_KEY: AuthApiKeyRecord = {
  id: 'key-1',
  prefix: 'ult_dev_key-1',
  keyHash: 'kh',
  userId: 'user-1',
  orgId: 'org-1',
  scopes: ['posts:write'],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: new Date(0),
};

const SERVICE: ServiceIdentity = { id: 'svc-1', orgId: 'org-1', scopes: ['jobs:run'] };

describe('actorFromUser', () => {
  test('a fully authenticated session gets its roles and permissions', () => {
    const actor = actorFromUser(USER, SESSION);
    expect(actor.kind).toBe('user');
    expect(actor.id).toBe('user-1');
    expect(actor.orgId).toBe('org-1');
    expect(actor.roles).toEqual(['editor']);
    expect(actor.permissions).toEqual(['posts:archive']);
    // The row's scopes reach `Actor.scopes`, which is the field `hasScope()` reads. Hardcoding
    // `[]` here made `hasScope(actor, 'tenancy:cross')` unsatisfiable by any human, so the
    // support surfaces gated on it could only be reached by a serviceActor minted in the handler
    // — which throws the operator's identity away and makes the sweep unattributable.
    expect(actor.scopes).toEqual(['tenancy:cross']);
  });

  test('an MFA-enrolled user with an unsatisfied session resolves to no roles/permissions', () => {
    const mfaUser: AuthUser = { ...USER, mfaSecret: 'BASE32SECRET' };
    const pendingSession: AuthSession = { ...SESSION, mfaSatisfied: false };
    const actor = actorFromUser(mfaUser, pendingSession);
    expect(actor.roles).toEqual([]);
    expect(actor.permissions).toEqual([]);
    // Scopes go with them: a half-authenticated request must not hold `tenancy:cross` either.
    expect(actor.scopes).toEqual([]);
    // Still a real, identified actor — not anonymous — so "finish MFA" routes stay reachable.
    expect(actor.kind).toBe('user');
    expect(actor.id).toBe('user-1');
  });

  test('an MFA-enrolled user with a satisfied session gets full roles/permissions', () => {
    const mfaUser: AuthUser = { ...USER, mfaSecret: 'BASE32SECRET' };
    const actor = actorFromUser(mfaUser, SESSION);
    expect(actor.roles).toEqual(['editor']);
    expect(actor.permissions).toEqual(['posts:archive']);
  });

  test('a user with no MFA secret is unaffected by session.mfaSatisfied', () => {
    const unsatisfied: AuthSession = { ...SESSION, mfaSatisfied: false };
    const actor = actorFromUser(USER, unsatisfied);
    expect(actor.roles).toEqual(['editor']);
  });
});

describe('actorFromApiKey', () => {
  test('scopes are exactly the key scopes, never the owner role set', () => {
    const actor = actorFromApiKey(API_KEY, ['posts:write', 'posts:read']);
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe('key-1');
    expect(actor.orgId).toBe('org-1');
    expect(actor.scopes).toEqual(['posts:write']);
    expect(actor.roles).toEqual([]);
    expect(actor.permissions).toEqual(['posts:write']);
  });

  // A key was minted with whatever list its issuer typed, so a member could hold a key reaching
  // further than their own account — and it kept that reach after a demotion.
  test('a key a user owns keeps only what that owner may do', () => {
    const key = { ...API_KEY, scopes: ['posts:write', 'billing:refund', 'posts:read'] };
    const actor = actorFromApiKey(key, ['posts:write', 'posts:read']);
    expect(actor.scopes).toEqual(['posts:write', 'posts:read']);
    expect(actor.permissions).toEqual(['posts:write', 'posts:read']);
    // An owner with nothing has a key with nothing — on both fields a policy reads.
    expect(actorFromApiKey(key, []).scopes).toEqual([]);
    expect(actorFromApiKey(key, []).permissions).toEqual([]);
  });

  test("the owner's wildcard grants cover, exactly as a role's do", () => {
    const scopes = ['posts:write', 'billing:refund'];
    expect(apiKeyScopes(scopes, ['posts:*'])).toEqual(['posts:write']);
    expect(apiKeyScopes(scopes, ['*'])).toEqual(scopes);
    // A resource is matched whole: `post` is not `posts`.
    expect(apiKeyScopes(scopes, ['post:*', 'billing'])).toEqual([]);
  });

  test('a key no user owns is not narrowed', () => {
    const key = { ...API_KEY, userId: null, scopes: ['posts:write', 'billing:refund'] };
    expect(actorFromApiKey(key, null).scopes).toEqual(['posts:write', 'billing:refund']);
  });

  test.each([
    ['owned', ['*', 'posts:*']],
    ['unowned', null],
  ] as const)('a wildcard scope on a stored key is never honoured (%s)', (_, grants) => {
    const key = { ...API_KEY, scopes: ['*', 'posts:*', 'posts:write'] };
    const actor = actorFromApiKey(key, grants);
    expect(actor.scopes).toEqual(['posts:write']);
    expect(actor.permissions).toEqual(['posts:write']);
  });
});

describe('actorFromService', () => {
  test('scopes are the grant; there are no roles', () => {
    const actor = actorFromService(SERVICE);
    expect(actor.kind).toBe('service');
    expect(actor.id).toBe('svc-1');
    expect(actor.orgId).toBe('org-1');
    expect(actor.scopes).toEqual(['jobs:run']);
    expect(actor.roles).toEqual([]);
    expect(actor.permissions).toEqual(['jobs:run']);
  });
});

describe('resolveActor', () => {
  test('dispatches "user" to actorFromUser', () => {
    const actor = resolveActor({ kind: 'user', user: USER, session: SESSION });
    expect(actor.kind).toBe('user');
    expect(actor.id).toBe('user-1');
  });

  test('dispatches "agent" to actorFromApiKey', () => {
    const actor = resolveActor({ kind: 'agent', apiKey: API_KEY, ownerGrants: [] });
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe('key-1');
    // The grants travel through the funnel: nothing the owner cannot do survives it.
    expect(actor.scopes).toEqual([]);
  });

  test('dispatches "service" to actorFromService', () => {
    const actor = resolveActor({ kind: 'service', service: SERVICE });
    expect(actor.kind).toBe('service');
    expect(actor.id).toBe('svc-1');
  });

  test('dispatches "anonymous" to an anonymous actor', () => {
    const actor = resolveActor({ kind: 'anonymous' });
    expect(actor.kind).toBe('anonymous');
    expect(actor.roles).toEqual([]);
    expect(actor.scopes).toEqual([]);
  });
});
