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
  throw new Error('expected the call to throw');
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
    expect(verified.id).toBe(issued.record.id);
    expect(verified.keyHash).toBe(issued.record.keyHash);
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

  test("the key's scopes become exactly the agent actor's scopes", () => {
    const clock = frozenClock(1_700_000_000_000);
    const issued = issueApiKey({
      env: 'prod',
      scopes: SCOPES,
      userId: 'user-1',
      orgId: 'org-1',
      clock,
    });
    const actor = apiKeyActor(issued.record);
    expect(actor.kind).toBe('agent');
    expect(actor.id).toBe(issued.record.id);
    expect(actor.orgId).toBe('org-1');
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
