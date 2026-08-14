// Direct coverage for the single funnel from identity to `Actor` — untested until now despite
// being the one place every ActorKind gets minted, including the MFA-pending narrowing that
// silently strips roles/permissions instead of throwing.

import { describe, expect, test } from 'bun:test';
import type { AuthApiKeyRecord, AuthSession, AuthUser } from './adapter';
import {
  actorFromApiKey,
  actorFromService,
  actorFromUser,
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
  mfaSecret: null,
  recoveryCodeHashes: [],
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
    expect(actor.scopes).toEqual([]);
  });

  test('an MFA-enrolled user with an unsatisfied session resolves to no roles/permissions', () => {
    const mfaUser: AuthUser = { ...USER, mfaSecret: 'BASE32SECRET' };
    const pendingSession: AuthSession = { ...SESSION, mfaSatisfied: false };
    const actor = actorFromUser(mfaUser, pendingSession);
    expect(actor.roles).toEqual([]);
    expect(actor.permissions).toEqual([]);
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
    const actor = actorFromApiKey(API_KEY);
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe('key-1');
    expect(actor.orgId).toBe('org-1');
    expect(actor.scopes).toEqual(['posts:write']);
    expect(actor.roles).toEqual([]);
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
    const actor = resolveActor({ kind: 'agent', apiKey: API_KEY });
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe('key-1');
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
