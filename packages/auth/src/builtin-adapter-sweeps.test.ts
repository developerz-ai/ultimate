// The optional `AuthAdapter` members and the two revocation sweeps. Split out of
// `builtin-adapter.test.ts` to stay under the 500-line ceiling `x verify`'s `filesize` step
// enforces; the same `createRecordingClient()` stands in for Postgres, so no database is needed.

import { describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient } from '@ultimat3/db';
import { BuiltinAdapter } from './builtin-adapter';

const ID = '00000000-0000-7000-8000-000000000101';

const userRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ID,
  email: 'ada@example.test',
  email_verified_at: null,
  password_hash: '$argon2id$v=19$m=19456,t=2,p=1$salt$hash',
  org_id: 'org-1',
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

/**
 * The optional members and the two sweeps. They exist because a revocation has to reach every
 * session a person or an org holds — `deleteSessionsForOrg` joins through `x_users` rather than
 * reading an `org_id` off the session, because that copy goes stale the moment somebody moves org
 * and a stale row is exactly the session the sweep was run to kill.
 */
describe('BuiltinAdapter — lookups and sweeps', () => {
  test('findUserByExternalId binds the id rather than interpolating it', async () => {
    setup();
    client.on('select', { rows: [userRow({ external_id: 'okta|42' })] });
    const user = await adapter.findUserByExternalId("okta|42'; drop table x_users; --");
    expect(lastText()).toContain('select * from x_users where external_id = $1');
    expect(lastText()).not.toContain('drop table');
    expect(lastValues()).toEqual(["okta|42'; drop table x_users; --"]);
    expect(user?.id).toBe(ID);

    setup();
    expect(await adapter.findUserByExternalId('nobody')).toBe(null);
  });

  test('listUsersByOrg excludes disabled members by default, in one constant statement', async () => {
    setup();
    client.on('select', { rows: [userRow(), userRow({ id: 'u2', email: 'bob@example.test' })] });
    const users = await adapter.listUsersByOrg('org-1');

    expect(lastText()).toContain('where org_id = $1');
    expect(lastText()).toContain('disabled_at is null');
    expect(lastText()).toContain('order by email asc');
    // Both filters are BOUND predicates, so the statement text is the same whatever is asked for.
    expect(lastValues()).toEqual(['org-1', false, true, null]);
    expect(users.map((user) => user.id)).toEqual([ID, 'u2']);
  });

  test('includeDisabled and role change the bound values, never the statement', async () => {
    setup();
    client.on('select', { rows: [] });
    await adapter.listUsersByOrg('org-1');
    const auditText = lastText();

    setup();
    client.on('select', { rows: [] });
    await adapter.listUsersByOrg('org-1', { includeDisabled: true, role: 'owner' });

    expect(lastText()).toBe(auditText);
    expect(lastValues()).toEqual(['org-1', true, false, 'owner']);
  });

  test('updateSession writes each field conditionally, so an absent one is not cleared', async () => {
    setup();
    client.on('update x_sessions', { rows: [sessionRow({ ip: '198.51.100.9' })] });
    const seen = new Date('2026-01-03T00:00:00.000Z');
    const session = await adapter.updateSession('sess-1', { lastSeenAt: seen, ip: '198.51.100.9' });

    expect(lastText()).toContain('update x_sessions set');
    expect(lastText()).toContain('else last_seen_at end');
    expect(lastText()).toContain('else user_agent end');
    // `mfaSatisfied` was not in the patch, so its "is it set" flag is false and the column holds.
    expect(lastValues()).toContain(seen);
    expect(lastValues()).toContain('198.51.100.9');
    expect(session?.ip).toBe('198.51.100.9');

    setup();
    expect(await adapter.updateSession('gone', { ip: null })).toBe(null);
  });

  test('deleteSessionsForUser removes every session that user holds', async () => {
    setup();
    client.on('delete from x_sessions', { affected: 4 });
    expect(await adapter.deleteSessionsForUser(ID)).toBe(4);
    expect(lastText()).toContain('delete from x_sessions where user_id = $1');
    expect(lastValues()).toEqual([ID]);
  });

  test('deleteSessionsForOrg joins through x_users instead of reading a copied org_id', async () => {
    setup();
    client.on('delete from x_sessions', { affected: 7 });
    expect(await adapter.deleteSessionsForOrg('org-1')).toBe(7);
    expect(lastText()).toContain('select id from x_users where org_id = $1');
    // The column that would have gone stale is not in the statement at all.
    expect(lastText()).not.toContain('x_sessions.org_id');
    expect(lastValues()).toEqual(['org-1']);
  });

  test('deleteSessionsCreatedBefore is the age sweep, bound to a Date', async () => {
    setup();
    client.on('delete from x_sessions', { affected: 12 });
    const before = new Date('2026-01-01T00:00:00.000Z');
    expect(await adapter.deleteSessionsCreatedBefore(before)).toBe(12);
    expect(lastText()).toContain('created_at < $1');
    expect(lastValues()).toEqual([before]);
  });

  test('listAccounts returns every linked provider for one user', async () => {
    setup();
    client.on('select', {
      rows: [
        {
          id: 'acct-1',
          user_id: ID,
          provider: 'github',
          provider_account_id: 'gh-1',
          access_token: 'token',
          refresh_token: null,
          expires_at: null,
          created_at: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
    const accounts = await adapter.listAccounts(ID);
    expect(lastText()).toContain('select * from x_accounts where user_id = $1');
    expect(accounts.map((account) => account.provider)).toEqual(['github']);
    expect(accounts[0]?.providerAccountId).toBe('gh-1');
  });

  test('findApiKeyById maps every column, and a missing row is null', async () => {
    setup();
    client.on('select', {
      rows: [
        {
          id: 'key-1',
          prefix: 'ult_live_key1',
          key_hash: 'b'.repeat(64),
          user_id: ID,
          org_id: null,
          scopes: ['posts:write'],
          last_used_at: '2026-01-02T03:04:05.000Z',
          expires_at: null,
          revoked_at: null,
          created_at: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
    const key = await adapter.findApiKeyById('key-1');
    expect(lastText()).toContain('select * from x_api_keys where id = $1');
    expect(key?.scopes).toEqual(['posts:write']);
    expect(key?.lastUsedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
    expect(key?.revokedAt).toBe(null);
    // The hash is what is stored; nothing here ever holds the plaintext key.
    expect(key?.keyHash).toBe('b'.repeat(64));

    setup();
    expect(await adapter.findApiKeyById('missing')).toBe(null);
  });
});
