// Direct coverage for the in-memory adapter's own semantics — every other test in this package
// uses it as a backing store, but nothing pinned its edge cases (case folding, patch-vs-omit,
// double-consume, double-revoke, sort order) directly until now.

import { describe, expect, test } from 'bun:test';
import type { AuthAccount, AuthApiKeyRecord, AuthSession, AuthVerification } from './adapter';
import { MemoryAdapter } from './memory-adapter';

const user = (overrides: Partial<Parameters<MemoryAdapter['createUser']>[0]> = {}) => ({
  id: 'user-1',
  email: 'A@Example.com',
  passwordHash: 'hash',
  orgId: 'org-1',
  roles: ['editor'],
  createdAt: new Date(0),
  ...overrides,
});

describe('users', () => {
  test('findUserByEmail is case-insensitive and trims whitespace', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createUser(user());

    expect((await adapter.findUserByEmail('a@example.com'))?.id).toBe('user-1');
    expect((await adapter.findUserByEmail('  A@Example.com  '))?.id).toBe('user-1');
    expect(await adapter.findUserByEmail('nobody@example.com')).toBeNull();
  });

  test('createUser stores the email normalized and starts with no permissions/mfa', async () => {
    const adapter = new MemoryAdapter();
    const created = await adapter.createUser(user());
    expect(created.email).toBe('a@example.com');
    expect(created.permissions).toEqual([]);
    expect(created.mfaSecret).toBeNull();
    expect(created.disabledAt).toBeNull();
  });

  test('findUserById returns null for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.findUserById('ghost')).toBeNull();
  });

  test('updateUser returns null for an unknown id, and does not create one', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.updateUser('ghost', { roles: ['admin'] })).toBeNull();
  });

  test('updateUser: an omitted field keeps the old value; an explicit null clears it', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createUser(user());
    await adapter.updateUser('user-1', { mfaSecret: 'SECRET' });

    // Omitted passwordHash -> unchanged.
    const afterMfa = await adapter.updateUser('user-1', { emailVerifiedAt: new Date(5) });
    expect(afterMfa?.passwordHash).toBe('hash');
    expect(afterMfa?.mfaSecret).toBe('SECRET');
    expect(afterMfa?.emailVerifiedAt).toEqual(new Date(5));

    // Explicit null -> cleared.
    const afterClear = await adapter.updateUser('user-1', { mfaSecret: null });
    expect(afterClear?.mfaSecret).toBeNull();
  });

  test('updateUser replaces roles wholesale, not merged', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createUser(user({ roles: ['editor', 'viewer'] }));
    const updated = await adapter.updateUser('user-1', { roles: ['admin'] });
    expect(updated?.roles).toEqual(['admin']);
  });
});

describe('sessions', () => {
  const session = (overrides: Partial<AuthSession> = {}): AuthSession => ({
    id: 'sess-1',
    userId: 'user-1',
    tokenHash: 'th',
    createdAt: new Date(0),
    absoluteExpiresAt: new Date(1_000),
    lastSeenAt: new Date(0),
    ip: null,
    userAgent: null,
    mfaSatisfied: false,
    ...overrides,
  });

  test('getSession returns null for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.getSession('ghost')).toBeNull();
  });

  test('updateSession returns null for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.updateSession('ghost', { mfaSatisfied: true })).toBeNull();
  });

  test('updateSession patches only the given fields', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createSession(session());
    const updated = await adapter.updateSession('sess-1', { ip: '1.2.3.4' });
    expect(updated?.ip).toBe('1.2.3.4');
    expect(updated?.userAgent).toBeNull();
    expect(updated?.mfaSatisfied).toBe(false);
  });

  test('deleteSession returns whether a row actually existed', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createSession(session());
    expect(await adapter.deleteSession('sess-1')).toBe(true);
    expect(await adapter.deleteSession('sess-1')).toBe(false);
  });

  test('deleteOtherSessions kills every session for the user except the kept one', async () => {
    const adapter = new MemoryAdapter();
    await adapter.createSession(session({ id: 's1' }));
    await adapter.createSession(session({ id: 's2' }));
    await adapter.createSession(session({ id: 's3', userId: 'user-2' }));

    const killed = await adapter.deleteOtherSessions('user-1', 's1');
    expect(killed).toBe(1);
    expect(await adapter.getSession('s1')).not.toBeNull();
    expect(await adapter.getSession('s2')).toBeNull();
    expect(await adapter.getSession('s3')).not.toBeNull();
  });

  test("listSessions returns only the user's sessions, newest lastSeenAt first", async () => {
    const adapter = new MemoryAdapter();
    await adapter.createSession(session({ id: 's1', lastSeenAt: new Date(100) }));
    await adapter.createSession(session({ id: 's2', lastSeenAt: new Date(300) }));
    await adapter.createSession(session({ id: 's3', userId: 'user-2', lastSeenAt: new Date(500) }));

    const listed = await adapter.listSessions('user-1');
    expect(listed.map((s) => s.id)).toEqual(['s2', 's1']);
  });
});

describe('accounts', () => {
  const account = (overrides: Partial<AuthAccount> = {}): AuthAccount => ({
    id: 'acc-1',
    userId: 'user-1',
    provider: 'github',
    providerAccountId: 'gh-1',
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    createdAt: new Date(0),
    ...overrides,
  });

  test('findAccount is keyed by provider + providerAccountId, not id', async () => {
    const adapter = new MemoryAdapter();
    await adapter.linkAccount(account());
    expect(await adapter.findAccount('github', 'gh-1')).not.toBeNull();
    expect(await adapter.findAccount('google', 'gh-1')).toBeNull();
  });

  test('listAccounts scopes to the given user', async () => {
    const adapter = new MemoryAdapter();
    await adapter.linkAccount(account({ id: 'a1' }));
    await adapter.linkAccount(account({ id: 'a2', userId: 'user-2', providerAccountId: 'gh-2' }));
    const listed = await adapter.listAccounts('user-1');
    expect(listed.map((a) => a.id)).toEqual(['a1']);
  });
});

describe('verifications', () => {
  const record = (overrides: Partial<AuthVerification> = {}): AuthVerification => ({
    id: 'v1',
    purpose: 'email-verify',
    identifier: 'a@example.com',
    tokenHash: 'hash',
    expiresAt: new Date(1_000),
    consumedAt: null,
    createdAt: new Date(0),
    ...overrides,
  });

  test('takeVerification returns the record once, then null on a second take', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putVerification(record());

    const first = await adapter.takeVerification('email-verify', 'a@example.com', 'hash');
    expect(first).not.toBeNull();
    expect(first?.consumedAt).not.toBeNull();

    const second = await adapter.takeVerification('email-verify', 'a@example.com', 'hash');
    expect(second).toBeNull();
  });

  test('takeVerification returns null for an unknown purpose/identifier pair', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.takeVerification('email-verify', 'nobody@example.com', 'hash')).toBeNull();
  });

  test('takeVerification consumes nothing when the hash does not match', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putVerification(record());

    expect(await adapter.takeVerification('email-verify', 'a@example.com', 'wrong')).toBeNull();
    // The live row survived the guess — otherwise one unauthenticated request kills the link.
    expect(await adapter.takeVerification('email-verify', 'a@example.com', 'hash')).not.toBeNull();
  });

  test('putVerification for the same purpose+identifier replaces the previous row', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putVerification(record({ id: 'v1', tokenHash: 'first' }));
    await adapter.putVerification(record({ id: 'v2', tokenHash: 'second' }));

    expect(await adapter.takeVerification('email-verify', 'a@example.com', 'first')).toBeNull();
    const taken = await adapter.takeVerification('email-verify', 'a@example.com', 'second');
    expect(taken?.id).toBe('v2');
    expect(taken?.tokenHash).toBe('second');
  });
});

describe('api keys', () => {
  const key = (overrides: Partial<AuthApiKeyRecord> = {}): AuthApiKeyRecord => ({
    id: 'key-1',
    prefix: 'ult_dev_key-1',
    keyHash: 'kh',
    userId: 'user-1',
    orgId: null,
    scopes: ['posts:write'],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date(0),
    ...overrides,
  });

  test('findApiKeyById returns null for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.findApiKeyById('ghost')).toBeNull();
  });

  test('listApiKeys matches on either userId or orgId as the owner', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putApiKey(key({ id: 'k1', userId: 'user-1', orgId: null }));
    await adapter.putApiKey(key({ id: 'k2', userId: null, orgId: 'org-1' }));
    await adapter.putApiKey(key({ id: 'k3', userId: 'user-2', orgId: 'org-2' }));

    expect((await adapter.listApiKeys('user-1')).map((k) => k.id)).toEqual(['k1']);
    expect((await adapter.listApiKeys('org-1')).map((k) => k.id)).toEqual(['k2']);
  });

  test('touchApiKey updates lastUsedAt, and is a no-op for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putApiKey(key());
    await adapter.touchApiKey('key-1', new Date(42));
    expect((await adapter.findApiKeyById('key-1'))?.lastUsedAt).toEqual(new Date(42));

    // Must not throw.
    await adapter.touchApiKey('ghost', new Date(42));
  });

  test('revokeApiKey succeeds once, then reports false for an already-revoked key', async () => {
    const adapter = new MemoryAdapter();
    await adapter.putApiKey(key());

    expect(await adapter.revokeApiKey('key-1', new Date(1))).toBe(true);
    expect((await adapter.findApiKeyById('key-1'))?.revokedAt).toEqual(new Date(1));
    expect(await adapter.revokeApiKey('key-1', new Date(2))).toBe(false);
  });

  test('revokeApiKey returns false for an unknown id', async () => {
    const adapter = new MemoryAdapter();
    expect(await adapter.revokeApiKey('ghost', new Date(1))).toBe(false);
  });
});
