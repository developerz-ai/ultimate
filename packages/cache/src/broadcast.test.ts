// Cross-instance invalidation, both halves. `invalidate.test.ts` owns the local fan-out; this
// file owns what leaves the process and what arrives from another one — and the property that
// matters most is the one that is NOT there: the inbound half never re-emits.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  invalidateTags,
  isolateTiers,
  receiveInvalidationBroadcast,
  registerInvalidationBroadcast,
  registerTier,
  resetTiers,
} from './invalidate';
import { lruTier } from './lru';
import { fakeRedis, tierFor } from './redis-fake-fixture';
import { declareTags, isolateDeclaredTags, resetDeclaredTags, tag } from './tags';

// Module scope, so the baseline is whatever a neighbouring file registered before this one ran.
const restoreRegistries = [isolateTiers(), isolateDeclaredTags()];

beforeEach(() => {
  resetTiers();
  resetDeclaredTags();
});

afterAll(() => {
  for (const restore of restoreRegistries) restore();
});

describe('cross-instance invalidation', () => {
  // Without the seam `invalidateTags` clears ONE process's LRU: a user edits their profile on
  // pod 3, their next request lands on pod 7, and pod 7 serves the pre-edit value for up to
  // `defaultTtlMs`. The user watches the edit vanish and re-submits.
  test('a local fan-out hands its wire tags to the registered broadcast, last', async () => {
    const order: string[] = [];
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier({
      ...lru,
      async invalidateTags(tags) {
        order.push('tier');
        return await lru.invalidateTags(tags);
      },
    });
    registerInvalidationBroadcast((wire) => {
      order.push(`broadcast:${wire.join(',')}`);
    });

    const report = await invalidateTags([tag('post', '1')]);

    expect(order).toEqual(['tier', 'broadcast:post:1']);
    expect(report.errors).toEqual([]);
  });

  test('the INBOUND half applies the tags and cannot re-emit — a broadcast storm is structural', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    let sends = 0;
    registerInvalidationBroadcast(async (wire) => {
      sends += 1;
      // The storm, attempted: a receiver that re-broadcast would recurse without a bound.
      await receiveInvalidationBroadcast(wire);
    });

    const report = await receiveInvalidationBroadcast(['post:1']);

    expect(sends).toBe(0);
    expect(report.tags).toEqual(['post:1']);
    expect(await lru.get('feed')).toBeUndefined();
  });

  // The sender's own bust already cleared the shared store for the whole fleet. Re-busting it on
  // every replica's receipt (the sender's included: a real bus delivers back) deleted the value a
  // reader had refilled since, re-bumped the fleet fence under every fill in flight, and cost each
  // mutation one extra load and a bust's worth of commands per replica.
  test('an inbound broadcast clears the in-process tier and sends nothing to a shared one', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });
    const server = fakeRedis();
    const shared = tierFor(server);
    registerTier(shared);
    await shared.set('feed', ['fresh'], { tags: [tag('post', '1')] });
    server.sent.length = 0;

    // `tierFor` opts out of the build id: its namespace is the bare prefix, `x`.
    const report = await receiveInvalidationBroadcast(['post:1'], { redis: 'x' });

    expect(await lru.get('feed')).toBeUndefined();
    expect(server.sent).toEqual([]);
    expect((await shared.get('feed'))?.value).toEqual(['fresh']);
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru']);
  });

  // A rolling deploy: old pods read `x:v1:*`, new ones `x:v2:*`, on ONE server. A write on a new
  // pod busts `x:v2` only; skipping the shared tier here left the old pod serving `x:v1`'s
  // pre-write row, re-promoted into its LRU, for the whole TTL.
  test("an inbound broadcast from another build still clears this build's shared tier", async () => {
    const server = fakeRedis();
    const shared = tierFor(server, { buildId: 'v1' });
    registerTier(shared);
    await shared.set('feed', ['pre-write'], { tags: [tag('post', '1')] });

    const report = await receiveInvalidationBroadcast(['post:1'], { redis: 'x:v2' });

    expect(await shared.get('feed')).toBeUndefined();
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['redis']);
  });

  // An older pod's frame names no scope: it cannot say which keys its bust cleared, so every tier
  // is cleared, as before the skip existed.
  test('an inbound broadcast that names no sender scope clears the shared tier', async () => {
    const server = fakeRedis();
    const shared = tierFor(server, { buildId: 'v1' });
    registerTier(shared);
    await shared.set('feed', ['pre-write'], { tags: [tag('post', '1')] });

    await receiveInvalidationBroadcast(['post:1']);

    expect(await shared.get('feed')).toBeUndefined();
  });

  test('the outbound broadcast names the shared scope its bust cleared', async () => {
    registerTier(lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 }));
    registerTier(tierFor(fakeRedis(), { buildId: 'v7' }));
    const scopes: unknown[] = [];
    registerInvalidationBroadcast((_wire, sender) => {
      scopes.push(sender);
    });

    await invalidateTags([tag('post', '1')]);

    expect(scopes).toEqual([{ redis: 'x:v7' }]);
  });

  // The peers skip what the sender names, so it names only what its bust actually cleared.
  test('a shared tier whose bust was refused here is not named to the peers', async () => {
    const shared = tierFor(fakeRedis(), { buildId: 'v7' });
    registerTier({ ...shared, invalidateTags: () => Promise.reject(new TypeError('timeout')) });
    const scopes: unknown[] = [];
    registerInvalidationBroadcast((_wire, sender) => {
      scopes.push(sender);
    });

    await invalidateTags([tag('post', '1')]);

    expect(scopes).toEqual([{}]);
  });

  // A fenced tier that names no scope cannot be proven the sender's: it is cleared.
  test('a fenced tier with no scope of its own is cleared inbound whatever the sender names', async () => {
    const server = fakeRedis();
    const { scope: _omitted, ...unscoped } = tierFor(server);
    registerTier(unscoped);
    await unscoped.set('feed', ['pre-write'], { tags: [tag('post', '1')] });

    await receiveInvalidationBroadcast(['post:1'], { redis: 'x' });

    expect(await unscoped.get('feed')).toBeUndefined();
  });

  test('a LOCAL bust still clears the shared tier', async () => {
    const server = fakeRedis();
    const shared = tierFor(server);
    registerTier(shared);
    await shared.set('feed', ['stale'], { tags: [tag('post', '1')] });

    await invalidateTags([tag('post', '1')]);

    expect(await shared.get('feed')).toBeUndefined();
  });

  test('a local bust whose receiver echoes back still sends exactly once', async () => {
    let sends = 0;
    registerInvalidationBroadcast(async (wire) => {
      sends += 1;
      await receiveInvalidationBroadcast(wire);
    });

    await invalidateTags([tag('post', '1')]);

    expect(sends).toBe(1);
  });

  test('a dead transport is reported, never thrown — the write that triggered it must not fail', async () => {
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });
    registerInvalidationBroadcast(() => Promise.reject(new Error('nats is down')));

    const report = await invalidateTags([tag('post')]);

    // `renderThrowable`'s shape: the renderer that cannot itself throw is the only one a catch
    // block absorbing an app-supplied refusal may use, and it carries the name.
    expect(report.errors).toEqual([{ tier: 'broadcast', message: 'Error: nats is down' }]);
    // The local tiers still cleared: a partial bust, honestly reported.
    expect(report.tiers.map((entry) => entry.tier)).toEqual(['lru']);
    expect(await lru.get('feed')).toBeUndefined();
  });

  test('an empty bust sends nothing at all', async () => {
    let sends = 0;
    registerInvalidationBroadcast(() => {
      sends += 1;
    });

    await invalidateTags([]);

    expect(sends).toBe(0);
  });

  test('an inbound tag this process never declared is dropped and reported, never thrown', async () => {
    // Mid-deploy the new pods know an entity the old ones do not. A throw here kills the
    // subscriber loop that delivered it, silently ending cross-instance invalidation.
    declareTags(['post']);
    const lru = lruTier({ maxBytes: 10_000, defaultTtlMs: 3_600_000 });
    registerTier(lru);
    await lru.set('feed', ['a'], { tags: [tag('post')] });

    const report = await receiveInvalidationBroadcast(['post:1', 'comment:9']);

    expect(report.tags).toEqual(['post:1']);
    expect(report.errors).toEqual([
      { tier: 'broadcast', message: 'ignored undeclared tag "comment:9"' },
    ]);
    expect(await lru.get('feed')).toBeUndefined();
  });

  test('resetTiers drops the broadcast along with everything else it drops', async () => {
    let sends = 0;
    registerInvalidationBroadcast(() => {
      sends += 1;
    });
    resetTiers();

    await invalidateTags([tag('post')]);

    expect(sends).toBe(0);
  });
});
