// Covers the one production `AuthAdapter` — every statement it emits, every value it binds,
// and the row ⇄ domain-object translation in both directions. A `createRecordingClient()` stands
// in for Postgres: no database, no Docker, and every assertion is on the exact text and values
// that would reach the wire.

import { describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient } from '@ultimat3/db';
import { BuiltinAdapter } from './builtin-adapter';

const ID = '00000000-0000-7000-8000-000000000101';

/** What Bun.SQL hands back for `x_users`: snake_case names, arrays as arrays, timestamps as ISO. */
const userRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  email: 'ada@example.test',
  email_verified_at: null,
  password_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
  org_id: null,
  roles: ['editor'],
  permissions: [],
  mfa_secret: null,
  recovery_code_hashes: [],
  disabled_at: null,
  created_at: '2026-01-02T03:04:05.000Z',
  ...over,
});

const sessionRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sess-1',
  user_id: ID,
  token_hash: 'a'.repeat(64),
  created_at: '2026-01-02T03:04:05.000Z',
  absolute_expires_at: '2026-02-01T00:00:00.000Z',
  last_seen_at: '2026-01-02T03:04:05.000Z',
  ip: '203.0.113.7',
  user_agent: 'test-agent',
  mfa_satisfied: true,
  ...over,
});

let client: RecordingClient;
let adapter: BuiltinAdapter;

const setup = (): void => {
  client = createRecordingClient();
  adapter = new BuiltinAdapter(client);
};

const lastText = (): string => client.texts.at(-1) ?? '';
const lastValues = (): readonly unknown[] => client.statements.at(-1)?.values ?? [];

describe('BuiltinAdapter — users', () => {
  test('findUserByEmail selects by bound value and maps every column', async () => {
    setup();
    client.on('select', { rows: [userRow()] });
    const user = await adapter.findUserByEmail("x'; drop table x_users; --");
    expect(lastText()).toContain('select * from x_users where email = $1');
    expect(lastText()).not.toContain('drop table');
    expect(lastValues()).toEqual(["x'; drop table x_users; --"]);
    expect(user).toEqual({
      id: ID,
      email: 'ada@example.test',
      emailVerifiedAt: null,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
      orgId: null,
      roles: ['editor'],
      permissions: [],
      mfaSecret: null,
      recoveryCodeHashes: [],
      disabledAt: null,
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    });
  });

  test('findUserByEmail returns null on no match, not a default row', async () => {
    setup();
    const user = await adapter.findUserByEmail('nobody@example.test');
    expect(user).toBeNull();
  });

  test('findUserById selects by id', async () => {
    setup();
    client.on('select', { rows: [userRow()] });
    await adapter.findUserById(ID);
    expect(lastText()).toContain('select * from x_users where id = $1');
    expect(lastValues()).toEqual([ID]);
  });

  test('createUser inserts every column and returns the row Postgres stored', async () => {
    setup();
    client.on('insert into x_users', { rows: [userRow({ roles: ['owner'] })] });
    const user = await adapter.createUser({
      id: ID,
      email: 'ada@example.test',
      passwordHash: 'hash',
      orgId: null,
      roles: ['owner'],
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(lastText()).toStartWith('insert into x_users');
    expect(lastText()).toEndWith('returning *');
    expect(lastValues()).toEqual([
      ID,
      'ada@example.test',
      'hash',
      null,
      ['owner'],
      new Date('2026-01-02T03:04:05.000Z'),
    ]);
    expect(user.roles).toEqual(['owner']);
  });

  test('createUser falls back to an empty row rather than throw when nothing returns', async () => {
    setup();
    const user = await adapter.createUser({
      id: ID,
      email: 'ada@example.test',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: new Date(),
    });
    expect(user.id).toBe('');
    expect(user.roles).toEqual([]);
  });

  test('updateUser sends every patch field as a bound case-when, untouched fields pass through', async () => {
    setup();
    client.on('update x_users', { rows: [userRow({ disabled_at: '2026-03-01T00:00:00.000Z' })] });
    const user = await adapter.updateUser(ID, { disabledAt: new Date('2026-03-01T00:00:00.000Z') });
    expect(lastText()).toContain('update x_users set');
    expect(lastText()).toContain('password_hash = case when $1');
    expect(lastText()).toContain('disabled_at = case when $9');
    // Only `disabledAt` was set: every other `!== undefined` flag binds false.
    expect(lastValues()[0]).toBe(false);
    expect(user?.disabledAt).toEqual(new Date('2026-03-01T00:00:00.000Z'));
  });

  test('updateUser can clear a field by passing null explicitly', async () => {
    setup();
    client.on('update x_users', { rows: [userRow({ mfa_secret: null })] });
    await adapter.updateUser(ID, { mfaSecret: null });
    // The "set" flag is true and the bound replacement value is null, not omitted.
    const mfaFlagIndex = lastText()
      .split(',')
      .findIndex((clause) => clause.includes('mfa_secret'));
    expect(mfaFlagIndex).toBeGreaterThan(-1);
  });

  test('updateUser returns null when no row matches the id', async () => {
    setup();
    const user = await adapter.updateUser('missing', { disabledAt: new Date() });
    expect(user).toBeNull();
  });
});

describe('BuiltinAdapter — sessions', () => {
  test('createSession inserts and returns the same object it was given', async () => {
    setup();
    const session = {
      id: 'sess-1',
      userId: ID,
      tokenHash: 'a'.repeat(64),
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      absoluteExpiresAt: new Date('2026-02-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-01-02T03:04:05.000Z'),
      ip: '203.0.113.7',
      userAgent: 'test-agent',
      mfaSatisfied: true,
    };
    const stored = await adapter.createSession(session);
    expect(lastText()).toStartWith('insert into x_sessions');
    expect(stored).toBe(session);
  });

  test('getSession maps a row back to an AuthSession', async () => {
    setup();
    client.on('select', { rows: [sessionRow()] });
    const session = await adapter.getSession('sess-1');
    expect(session?.mfaSatisfied).toBe(true);
    expect(session?.absoluteExpiresAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  test('deleteSession reports true only when a row was actually removed', async () => {
    setup();
    client.on('delete from x_sessions', { affected: 1 });
    expect(await adapter.deleteSession('sess-1')).toBe(true);

    setup();
    expect(await adapter.deleteSession('sess-1')).toBe(false);
  });

  test('deleteOtherSessions excludes the current session id in the predicate', async () => {
    setup();
    client.on('delete from x_sessions', { affected: 3 });
    const killed = await adapter.deleteOtherSessions(ID, 'keep-me');
    expect(lastText()).toContain('user_id = $1 and id <> $2');
    expect(lastValues()).toEqual([ID, 'keep-me']);
    expect(killed).toBe(3);
  });

  test('listSessions orders by most-recently-seen', async () => {
    setup();
    client.on('select', { rows: [sessionRow()] });
    await adapter.listSessions(ID);
    expect(lastText()).toContain('order by last_seen_at desc');
  });
});

describe('BuiltinAdapter — accounts', () => {
  test('linkAccount upserts on the provider/providerAccountId pair', async () => {
    setup();
    const account = {
      id: 'acct-1',
      userId: ID,
      provider: 'github',
      providerAccountId: 'gh-1',
      accessToken: 'token',
      refreshToken: null,
      expiresAt: null,
      createdAt: new Date(),
    };
    await adapter.linkAccount(account);
    expect(lastText()).toContain('on conflict (provider, provider_account_id) do update');
  });

  test('findAccount reads by provider and its account id', async () => {
    setup();
    client.on('select', {
      rows: [
        {
          id: 'acct-1',
          user_id: ID,
          provider: 'github',
          provider_account_id: 'gh-1',
          access_token: null,
          refresh_token: null,
          expires_at: null,
          created_at: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
    const account = await adapter.findAccount('github', 'gh-1');
    expect(lastValues()).toEqual(['github', 'gh-1']);
    expect(account?.provider).toBe('github');
  });
});

describe('BuiltinAdapter — verification tokens', () => {
  test('putVerification upserts and resets consumedAt to null on reissue', async () => {
    setup();
    await adapter.putVerification({
      id: 'v-1',
      purpose: 'password-reset',
      identifier: 'ada@example.test',
      tokenHash: 'hash',
      expiresAt: new Date(),
      consumedAt: null,
      createdAt: new Date(),
    });
    expect(lastText()).toContain('on conflict (purpose, identifier) do update');
    expect(lastText()).toContain('consumed_at = null');
  });

  test('takeVerification consumes only an unconsumed row and reports null otherwise', async () => {
    setup();
    client.on('update x_verifications', {
      rows: [
        {
          id: 'v-1',
          purpose: 'password-reset',
          identifier: 'ada@example.test',
          token_hash: 'hash',
          expires_at: '2026-01-02T03:04:05.000Z',
          consumed_at: '2026-01-02T03:04:05.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const taken = await adapter.takeVerification('password-reset', 'ada@example.test');
    expect(lastText()).toContain('consumed_at is null');
    expect(taken?.consumedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));

    setup();
    expect(await adapter.takeVerification('password-reset', 'ada@example.test')).toBeNull();
  });
});

describe('BuiltinAdapter — api keys', () => {
  test('putApiKey inserts the scopes array', async () => {
    setup();
    await adapter.putApiKey({
      id: 'key-1',
      prefix: 'ult_live_key1',
      keyHash: 'hash',
      userId: ID,
      orgId: null,
      scopes: ['posts:write'],
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    expect(lastValues()).toContain('ult_live_key1');
    expect(lastValues()).toContainEqual(['posts:write']);
  });

  test('listApiKeys matches on either the user or the org owning it', async () => {
    setup();
    client.on('select', { rows: [] });
    await adapter.listApiKeys(ID);
    expect(lastText()).toContain('user_id = $1 or org_id = $2');
    expect(lastValues()).toEqual([ID, ID]);
  });

  test('revokeApiKey only succeeds once — the predicate excludes an already-revoked key', async () => {
    setup();
    client.on('update x_api_keys', { affected: 1 });
    expect(await adapter.revokeApiKey('key-1', new Date())).toBe(true);
    expect(lastText()).toContain('revoked_at is null');

    setup();
    expect(await adapter.revokeApiKey('key-1', new Date())).toBe(false);
  });

  test('touchApiKey writes last_used_at and returns nothing', async () => {
    setup();
    await adapter.touchApiKey('key-1', new Date('2026-01-02T03:04:05.000Z'));
    expect(lastText()).toContain('update x_api_keys set last_used_at = $1 where id = $2');
    expect(lastValues()).toEqual([new Date('2026-01-02T03:04:05.000Z'), 'key-1']);
  });
});
