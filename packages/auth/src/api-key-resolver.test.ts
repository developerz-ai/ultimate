// `apiKeyResolver()` — the `resolveToken` a bearer mount and an MCP endpoint are handed: a
// presented key in, the agent actor and its scopes out, and ONE indistinguishable `null` for
// every way a key can be wrong. A fault is not a wrong key and is never answered as one.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { apiKeyResolver } from './api-key-resolver';
import { type ApiKeyVerifyStore, issueApiKey, revokeApiKey } from './api-keys';
import { MemoryAdapter } from './memory-adapter';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const clock = frozenClock('2026-10-01T09:00:00.000Z');

const issueInto = async (
  store: ApiKeyVerifyStore,
  over: { expiresAt?: Date; userId?: string } = {},
) => {
  const issued = issueApiKey({
    env: 'dev',
    scopes: ['run:write', 'run:read'],
    orgId: ORG,
    clock,
    ...over,
  });
  await store.putApiKey(issued.record);
  return issued;
};

describe('apiKeyResolver', () => {
  test('an issued key resolves to the agent actor for its org, carrying exactly its scopes', async () => {
    const store = new MemoryAdapter(clock);
    const issued = await issueInto(store);

    const caller = await apiKeyResolver(() => store, { clock })(issued.plaintext);

    expect(caller?.actor.kind).toBe('agent');
    expect(caller?.actor.orgId).toBe(ORG);
    // The identity is the KEY, not its owning user — and the actor carries the key's scopes too.
    expect(caller?.actor.id).toBe(issued.record.id);
    expect([...(caller?.actor.scopes ?? [])].sort()).toEqual([...issued.record.scopes].sort());
    expect([...(caller?.scopes ?? [])].sort()).toEqual(['run:read', 'run:write']);
    // A verified use is recorded, as `verifyApiKey` does for every caller.
    expect((await store.findApiKeyById(issued.record.id))?.lastUsedAt).toEqual(clock.now());
  });

  test('every wrong key is the same null: malformed, unknown, wrong secret, revoked, expired', async () => {
    const store = new MemoryAdapter(clock);
    const resolve = apiKeyResolver(() => store, { clock });
    const issued = await issueInto(store);
    const expired = await issueInto(store, { expiresAt: new Date(clock.now().getTime() - 1) });

    expect(await resolve('not a key')).toBeNull();
    expect(await resolve('ult_dev_0000000000000000_secret')).toBeNull();
    expect(await resolve(`${issued.record.prefix}_wrong`)).toBeNull();
    expect(await resolve(expired.plaintext)).toBeNull();
    expect(await revokeApiKey(store, issued.record.id, clock)).toBe(true);
    expect(await resolve(issued.plaintext)).toBeNull();
  });

  test('a store that FAILS is a fault, never a wrong key', async () => {
    const down = new TypeError('connection refused');
    const store: ApiKeyVerifyStore = {
      findUserById: () => Promise.resolve(null),
      putApiKey: (record) => Promise.resolve(record),
      findApiKeyById: () => Promise.reject(down),
      listApiKeys: () => Promise.resolve([]),
      touchApiKey: () => Promise.resolve(),
      revokeApiKey: () => Promise.resolve(false),
    };
    const refused = await apiKeyResolver(() => store)('ult_dev_0000000000000000_secret').catch(
      (thrown: unknown) => thrown,
    );
    // Answered `null` it would be a 401 — "your key is wrong" — for a database that is down.
    expect(refused).toBe(down);
    expect(isUltimateError(refused)).toBe(false);
  });

  test('the store is read when a token is presented, so it may be built after the declaration', async () => {
    let store: ApiKeyVerifyStore | undefined;
    // Declared first, as a module evaluated before boot declares its mount.
    const resolve = apiKeyResolver(() => store ?? expect.unreachable('asked before boot'));
    store = new MemoryAdapter(clock);
    const issued = await issueInto(store);
    expect((await resolve(issued.plaintext))?.actor.id).toBeDefined();
  });

  // What a bearer mount and an MCP endpoint both do with this `null` is answer 401 — so this is
  // the one place a disabled owner's key is refused for both.
  test('a key whose owner was disabled is the same null on the next request', async () => {
    const store = new MemoryAdapter(clock);
    const owner = await store.createUser({
      id: 'ada',
      email: 'ada@corp.test',
      passwordHash: null,
      orgId: ORG,
      roles: [],
      createdAt: clock.now(),
    });
    await store.updateUser(owner.id, { permissions: ['run:read'] });
    const issued = await issueInto(store, { userId: owner.id });
    const resolve = apiKeyResolver(() => store, { clock });

    const live = await resolve(issued.plaintext);
    // Cut by the owner's grants, on the actor AND on the set the mount's scope map reads.
    expect([...(live?.actor.scopes ?? [])]).toEqual(['run:read']);
    expect([...(live?.scopes ?? [])]).toEqual(['run:read']);

    await store.updateUser(owner.id, { disabledAt: clock.now() });
    expect(await resolve(issued.plaintext)).toBeNull();
  });

  test('grantsOf reaches the actor: a role-based owner keeps what the role grants', async () => {
    const store = new MemoryAdapter(clock);
    await store.createUser({
      id: 'ada',
      email: 'ada@corp.test',
      passwordHash: null,
      orgId: ORG,
      roles: ['operator'],
      createdAt: clock.now(),
    });
    const issued = await issueInto(store, { userId: 'ada' });
    expect([
      ...((await apiKeyResolver(() => store, { clock })(issued.plaintext))?.scopes ?? []),
    ]).toEqual([]);
    const resolve = apiKeyResolver(() => store, {
      clock,
      grantsOf: (owner) => (owner.roles.includes('operator') ? ['run:*'] : []),
    });
    expect([...((await resolve(issued.plaintext))?.scopes ?? [])].sort()).toEqual([
      'run:read',
      'run:write',
    ]);
  });
});
