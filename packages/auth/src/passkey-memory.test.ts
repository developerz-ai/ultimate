// The memory passkey store's challenge sweep: an expired challenge is dropped on a later put, a live
// one never is, and the sweep is amortised — `loginOptions` is unauthenticated, so a put that
// rescanned every live challenge made a flood within one TTL cost quadratic time.

import { describe, expect, test } from 'bun:test';
import type { PasskeyChallengeRecord } from './adapter';
import { memoryPasskeyStore } from './passkey-memory';

const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
const TTL = 300_000;

const challenge = (id: string, atMs: number, ttlMs = TTL): PasskeyChallengeRecord => ({
  id,
  ceremony: 'login',
  userId: null,
  digest: null,
  nonce: null,
  expiresAt: new Date(atMs + ttlMs),
  createdAt: new Date(atMs),
});

describe('memoryPasskeyStore challenges', () => {
  test('a later put sweeps an expired challenge and keeps a live one', async () => {
    const store = memoryPasskeyStore();
    await store.putPasskeyChallenge(challenge('old', T0));
    await store.putPasskeyChallenge(challenge('live', T0 + TTL));
    await store.putPasskeyChallenge(challenge('new', T0 + TTL + 1));
    expect(await store.takePasskeyChallenge('old', 'login')).toBeNull();
    expect((await store.takePasskeyChallenge('live', 'login'))?.id).toBe('live');
    expect((await store.takePasskeyChallenge('new', 'login'))?.id).toBe('new');
  });

  test('a longer-lived challenge ahead of an expired one is never swept early', async () => {
    const store = memoryPasskeyStore();
    await store.putPasskeyChallenge(challenge('long', T0, TTL * 10));
    await store.putPasskeyChallenge(challenge('short', T0, 1));
    await store.putPasskeyChallenge(challenge('next', T0 + TTL));
    expect((await store.takePasskeyChallenge('long', 'login'))?.id).toBe('long');
  });

  // Counted, never timed: each read of a stored record's `expiresAt` is one step of the sweep.
  test('N live puts read O(N) expiries, not O(N^2)', async () => {
    const store = memoryPasskeyStore();
    let reads = 0;
    const counted = (id: string, atMs: number): PasskeyChallengeRecord => {
      const record = challenge(id, atMs);
      return {
        ...record,
        get expiresAt() {
          reads += 1;
          return record.expiresAt;
        },
      };
    };
    const N = 2_000;
    for (let i = 0; i < N; i += 1) await store.putPasskeyChallenge(counted(`c${i}`, T0 + i));
    expect(reads).toBeLessThanOrEqual(2 * N);
  });
});
