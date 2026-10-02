import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import {
  apiKeyActor,
  describeApiKey,
  issueApiKey,
  parseApiKey,
  revokeApiKey,
  verifyApiKey,
} from './api-keys';
import { AuthError } from './errors';
import { MemoryAdapter } from './memory-adapter';

const SCOPES = ['post:read', 'post:publish'] as const;

const caught = async (fn: () => Promise<unknown>): Promise<AuthError> => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AuthError) return error;
    throw error;
  }
  return expect.unreachable('expected the call to throw');
};

const START = 1_700_000_000_000;

/** A store holding one user, and a key that user owns. */
const owned = async (over: { permissions?: readonly string[] } = {}) => {
  const clock = frozenClock(START);
  const store = new MemoryAdapter(clock);
  const owner = await store.createUser({
    id: 'user-1',
    email: 'ada@corp.test',
    passwordHash: null,
    orgId: 'org-1',
    roles: ['member'],
    createdAt: new Date(START),
  });
  await store.updateUser(owner.id, { permissions: over.permissions ?? [...SCOPES] });
  const issued = issueApiKey({ env: 'prod', scopes: SCOPES, userId: owner.id, clock });
  await store.putApiKey(issued.record);
  return { store, clock, issued };
};

describe('api keys', () => {
  test('verify matches the stored hash and the plaintext is nowhere in the record', async () => {
    const store = new MemoryAdapter();
    const clock = frozenClock(1_700_000_000_000);
    const issued = issueApiKey({ env: 'prod', scopes: SCOPES, orgId: 'org-1', clock });
    await store.putApiKey(issued.record);

    const parsed = parseApiKey(issued.plaintext);
    expect(parsed?.prefix).toBe(issued.record.prefix);

    const serialised = JSON.stringify(issued.record);
    expect(serialised).not.toContain(issued.plaintext);
    expect(serialised).not.toContain(parsed?.secret ?? '<missing>');
    expect(issued.record.keyHash).not.toBe(parsed?.secret);

    const verified = await verifyApiKey(store, issued.plaintext, clock);
    expect(verified.record.id).toBe(issued.record.id);
    expect(verified.record.keyHash).toBe(issued.record.keyHash);
    // A key no user owns has no owner to answer for it.
    expect(verified.owner).toBeNull();
  });

  test('a revoked key fails with X_API_KEY_INVALID', async () => {
    const store = new MemoryAdapter();
    const clock = frozenClock(1_700_000_000_000);
    const issued = issueApiKey({ env: 'prod', scopes: SCOPES, clock });
    await store.putApiKey(issued.record);

    expect(await revokeApiKey(store, issued.record.id, clock)).toBe(true);
    const error = await caught(() => verifyApiKey(store, issued.plaintext, clock));
    expect(error.code).toBe('X_API_KEY_INVALID');
  });

  test('an expired key and a forged secret fail identically', async () => {
    const store = new MemoryAdapter();
    const clock = frozenClock(1_700_000_000_000);
    const expired = issueApiKey({
      env: 'prod',
      scopes: SCOPES,
      expiresAt: new Date(1_699_999_999_000),
      clock,
    });
    await store.putApiKey(expired.record);
    const live = issueApiKey({ env: 'prod', scopes: SCOPES, clock });
    await store.putApiKey(live.record);

    const expiredError = await caught(() => verifyApiKey(store, expired.plaintext, clock));
    const forgedError = await caught(() =>
      verifyApiKey(store, `${live.record.prefix}_forged-secret-value`, clock),
    );
    expect(expiredError.format()).toBe(forgedError.format());
    expect(expiredError.code).toBe('X_API_KEY_INVALID');
  });

  test("the key's scopes become exactly the agent actor's scopes", async () => {
    const { store, clock, issued } = await owned();
    const actor = apiKeyActor(await verifyApiKey(store, issued.plaintext, clock));
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe(issued.record.id);
    expect([...actor.scopes]).toEqual([...SCOPES]);
    // Never widened: an api key grants no roles, only its own scopes.
    expect([...actor.roles]).toEqual([]);
  });

  test('the summary shown in a dashboard carries no secret material', () => {
    const clock = frozenClock(1_700_000_000_000);
    const issued = issueApiKey({ env: 'dev', scopes: SCOPES, clock });
    const summary = describeApiKey(issued.record);
    expect(JSON.stringify(summary)).not.toContain(issued.record.keyHash);
    expect(summary.prefix.startsWith('ult_dev_')).toBe(true);
  });
});

// The failure case first: a user minted a key and was then disabled. The session surface re-reads
// `disabledAt` on every request; key verification never looked at the owner at all, so the key
// went on resolving to its full scopes on every bearer mount and MCP endpoint.
describe("a key is its owner's credential", () => {
  test("a disabled owner's key is refused, and re-enabling restores it", async () => {
    const { store, clock, issued } = await owned();
    expect((await verifyApiKey(store, issued.plaintext, clock)).owner?.id).toBe('user-1');

    await store.updateUser('user-1', { disabledAt: new Date(START) });
    const refused = await caught(() => verifyApiKey(store, issued.plaintext, clock));
    expect(refused.code).toBe('X_API_KEY_INVALID');
    // Indistinguishable from every other rejection, by the factory's own contract.
    const unknown = await caught(() => verifyApiKey(store, 'ult_prod_0000_nope', clock));
    expect(refused.format()).toBe(unknown.format());

    await store.updateUser('user-1', { disabledAt: null });
    expect((await verifyApiKey(store, issued.plaintext, clock)).record.id).toBe(issued.record.id);
  });

  test('a key whose owner no longer exists is refused', async () => {
    const clock = frozenClock(START);
    const store = new MemoryAdapter(clock);
    const orphan = issueApiKey({ env: 'prod', scopes: SCOPES, userId: 'gone', clock });
    await store.putApiKey(orphan.record);
    expect((await caught(() => verifyApiKey(store, orphan.plaintext, clock))).code).toBe(
      'X_API_KEY_INVALID',
    );
  });

  test('a refused key is not stamped as used', async () => {
    const { store, clock, issued } = await owned();
    await store.updateUser('user-1', { disabledAt: new Date(START) });
    await caught(() => verifyApiKey(store, issued.plaintext, clock));
    expect((await store.findApiKeyById(issued.record.id))?.lastUsedAt).toBeNull();
  });

  test('a service key — no owner — verifies exactly as before, with no user lookup', async () => {
    const clock = frozenClock(START);
    const store = new MemoryAdapter(clock);
    const issued = issueApiKey({ env: 'prod', scopes: SCOPES, orgId: 'org-1', clock });
    await store.putApiKey(issued.record);
    store.findUserById = () => expect.unreachable('a service key has no owner to load');
    const verified = await verifyApiKey(store, issued.plaintext, clock);
    expect([...apiKeyActor(verified).scopes]).toEqual([...SCOPES]);
  });

  test('a wrong secret costs no owner lookup', async () => {
    const { store, clock, issued } = await owned();
    store.findUserById = () => expect.unreachable('the secret did not match');
    const forged = `${issued.record.prefix}_forged-secret-value`;
    expect((await caught(() => verifyApiKey(store, forged, clock))).code).toBe('X_API_KEY_INVALID');
  });

  test('a non-string key is the coded refusal, never a TypeError', async () => {
    const { store, clock } = await owned();
    for (const key of [undefined, null, 42]) {
      const refused = await caught(() => verifyApiKey(store, key as unknown as string, clock));
      expect(refused.code).toBe('X_API_KEY_INVALID');
    }
  });

  test('the actor carries only what the owner may do, by the grants the app names', async () => {
    const { store, clock, issued } = await owned({ permissions: ['post:read'] });
    const verified = await verifyApiKey(store, issued.plaintext, clock);
    expect([...apiKeyActor(verified).scopes]).toEqual(['post:read']);
    // Roles are expanded by the app: this package cannot read a role's permissions.
    const byRole = apiKeyActor(verified, {
      grantsOf: (owner) => (owner.roles.includes('member') ? ['post:*'] : []),
    });
    expect([...byRole.scopes]).toEqual([...SCOPES]);
  });
});

describe('a wildcard scope is refused at issue', () => {
  test.each(['*', 'post:*', 'admin:*'])('%p is X_CONFIG_INVALID', (scope) => {
    try {
      issueApiKey({ env: 'prod', scopes: ['post:read', scope] });
      expect.unreachable('a wildcard scope is refused');
    } catch (error) {
      expect(error instanceof AuthError ? error.code : 'not-an-auth-error').toBe(
        'X_CONFIG_INVALID',
      );
    }
  });

  test('a scope that merely contains a star is a name, not a wildcard', () => {
    expect(issueApiKey({ env: 'prod', scopes: ['post:*:read'] }).record.scopes).toEqual([
      'post:*:read',
    ]);
  });
});

// `issueApiKey({ env: 'live_eu' })` minted `ult_live_eu_<id>_<secret>`, which `parseApiKey` splits
// as env `live`, id `eu` — a key its own verifier refused, handed out as if it worked.
describe('an env the parser cannot read back is refused at issue', () => {
  const codeOf = (env: string): string | undefined => {
    try {
      issueApiKey({ env, scopes: ['posts:read'] });
      return undefined;
    } catch (error) {
      return error instanceof AuthError ? error.code : 'not-an-auth-error';
    }
  };

  test.each(['live_eu', '', 'Prod', 'prod env'])('%p is X_CONFIG_INVALID', (env) => {
    expect(codeOf(env)).toBe('X_CONFIG_INVALID');
  });

  test.each(['dev', 'prod', 'live-eu', 'stage2'])('%p round-trips through parseApiKey', (env) => {
    const issued = issueApiKey({ env, scopes: ['posts:read'] });
    expect(parseApiKey(issued.plaintext)?.env).toBe(env);
    expect(parseApiKey(issued.plaintext)?.id).toBe(issued.record.id);
  });

  test('the refusal names the separator and the spelling that works', () => {
    try {
      issueApiKey({ env: 'live_eu', scopes: [] });
      expect.unreachable('live_eu is refused');
    } catch (error) {
      expect(String((error as AuthError).cause)).toContain('"_"');
      expect(String((error as AuthError).fix)).toContain('live-eu');
    }
  });
});
