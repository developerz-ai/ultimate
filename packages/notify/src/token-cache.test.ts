// The credential cache: one mint per lifetime, replaced BEFORE expiry rather than after a refusal,
// one mint shared by concurrent sends, a failed mint never cached, and an invalidation that names
// the token it was refused with, so a straggler's late refusal never drops the fresh one.

import { describe, expect, test } from 'bun:test';
import type { MintedToken } from './token-cache';
import { tokenCache } from './token-cache';

const harness = (lifetimeMs = 60_000) => {
  let now = 0;
  let minted = 0;
  const pending: ((token: MintedToken) => void)[] = [];
  return {
    advance: (ms: number) => {
      now += ms;
    },
    minted: () => minted,
    mintNow: () => async (): Promise<MintedToken> => {
      minted += 1;
      return { value: `t${String(minted)}`, expiresAt: now + lifetimeMs };
    },
    mintLater: () => (): Promise<MintedToken> => {
      minted += 1;
      return new Promise((resolve) => pending.push(resolve));
    },
    settle: (value: string) => pending.shift()?.({ value, expiresAt: now + lifetimeMs }),
    now: () => now,
  };
};

describe('unit · tokenCache', () => {
  test('reused until refreshBeforeMs of its expiry, then replaced', async () => {
    const h = harness();
    const cache = tokenCache(h.mintNow(), h.now, 10_000);
    expect(await cache.get()).toBe('t1');
    h.advance(49_999);
    expect(await cache.get()).toBe('t1');
    h.advance(1);
    expect(await cache.get()).toBe('t2');
  });

  test('concurrent callers share one mint', async () => {
    const h = harness();
    const cache = tokenCache(h.mintLater(), h.now, 0);
    const both = Promise.all([cache.get(), cache.get()]);
    h.settle('shared');
    expect(await both).toEqual(['shared', 'shared']);
    expect(h.minted()).toBe(1);
  });

  test('a failed mint is not cached', async () => {
    let calls = 0;
    const cache = tokenCache(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new RangeError('provider down'))
          : Promise.resolve({ value: 'ok', expiresAt: 1e12 });
      },
      () => 0,
      0,
    );
    await expect(cache.get()).rejects.toThrow('provider down');
    expect(await cache.get()).toBe('ok');
  });

  test('invalidating the token in use forces a mint', async () => {
    const h = harness();
    const cache = tokenCache(h.mintNow(), h.now, 0);
    const used = await cache.get();
    cache.invalidate(used);
    expect(await cache.get()).toBe('t2');
    expect(h.minted()).toBe(2);
  });

  test('a late refusal for a token already replaced keeps the fresh one', async () => {
    const h = harness();
    const cache = tokenCache(h.mintNow(), h.now, 0);
    // Two sends hold t1; the first refusal replaces it, the straggler's must not drop t2.
    const held = await cache.get();
    cache.invalidate(held);
    expect(await cache.get()).toBe('t2');
    cache.invalidate(held);
    expect(await cache.get()).toBe('t2');
    expect(h.minted()).toBe(2);
  });

  test('a refusal for the old token leaves a mint already in flight to finish', async () => {
    const h = harness();
    const cache = tokenCache(h.mintLater(), h.now, 0);
    const first = cache.get();
    h.settle('t1');
    const held = await first;
    cache.invalidate(held);
    const fresh = cache.get();
    cache.invalidate(held);
    h.settle('t2');
    expect(await fresh).toBe('t2');
    expect(await cache.get()).toBe('t2');
    expect(h.minted()).toBe(2);
  });
});
