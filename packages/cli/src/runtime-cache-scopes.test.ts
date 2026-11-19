// The broadcast frame across a rolling deploy, in both directions: a bust names the shared scope
// it cleared after its tags, a receiver skips a shared tier only for its own scope, and a frame
// from either side of the deploy is read by the other.

import { afterEach, describe, expect, test } from 'bun:test';
import { declareTags, invalidateTags, isolateDeclaredTags, noopPurgeDriver } from '@ultimat3/cache';
import type { CacheTier } from '@ultimat3/cache/adapter';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { CACHE_INVALIDATE_SUBJECT, startCacheTiers } from './runtime-cache';
import { turns } from './runtime-turns-fixture';

let release: (() => Promise<void>) | undefined;
const restoreTags = isolateDeclaredTags();

afterEach(async () => {
  await release?.();
  release = undefined;
  restoreTags();
});

/** A shared rung in the namespace `scope`, counting the busts it is asked for. */
function sharedRung(scope: string): { tier: CacheTier; busts: string[][] } {
  const busts: string[][] = [];
  const tier: CacheTier = {
    name: 'redis',
    scope,
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
    del: () => Promise.resolve(),
    fence: () => Promise.reject(new TypeError('no read runs in this file')),
    invalidateTags(tags) {
      busts.push(tags.map((one) => `${one.entity}:${one.id ?? ''}`));
      return Promise.resolve({ tier: 'redis', keys: [] });
    },
  };
  return { tier, busts };
}

function boot(scope: string): { transport: InProcessTransport; busts: string[][] } {
  declareTags(['post']);
  const transport = new InProcessTransport();
  const rung = sharedRung(scope);
  release = startCacheTiers({
    env: {},
    purge: noopPurgeDriver(),
    transport,
    tiers: ['redis'],
    supplied: [rung.tier],
  });
  return { transport, busts: rung.busts };
}

describe('the invalidation frame across a rolling deploy', () => {
  test('a bust names the shared scope it cleared, after its tags', async () => {
    const { transport } = boot('x:v2');
    const seen: string[] = [];
    await transport.subscribe(CACHE_INVALIDATE_SUBJECT, (payload) => {
      seen.push(payload);
    });

    await invalidateTags([{ entity: 'post', id: '1' }]);

    expect(seen.map((payload) => JSON.parse(payload))).toEqual([
      ['post:1', { scopes: { redis: 'x:v2' } }],
    ]);
    // What every receiver since v30 does with it (`applyBroadcast`: strings only): the tags, and
    // no scope — so an older pod busts every tier, which is correct across two namespaces.
    const older = (JSON.parse(seen[0] as string) as unknown[]).filter(
      (value) => typeof value === 'string',
    );
    expect(older).toEqual(['post:1']);
  });

  test("a peer frame naming THIS build's scope skips the shared tier", async () => {
    const { transport, busts } = boot('x:v2');
    await transport.publish(
      CACHE_INVALIDATE_SUBJECT,
      JSON.stringify(['post:1', { scopes: { redis: 'x:v2' } }]),
    );
    await turns(20);
    expect(busts).toEqual([]);
  });

  test("a peer frame from another build busts this build's shared tier", async () => {
    const { transport, busts } = boot('x:v1');
    await transport.publish(
      CACHE_INVALIDATE_SUBJECT,
      JSON.stringify(['post:1', { scopes: { redis: 'x:v2' } }]),
    );
    await turns(20);
    expect(busts).toEqual([['post:1']]);
  });

  test("an older pod's frame (tags only) busts the shared tier", async () => {
    const { transport, busts } = boot('x:v2');
    await transport.publish(CACHE_INVALIDATE_SUBJECT, JSON.stringify(['post:1']));
    await turns(20);
    expect(busts).toEqual([['post:1']]);
  });

  test('a scope entry that is not a string is no scope at all', async () => {
    const { transport, busts } = boot('x:v2');
    await transport.publish(
      CACHE_INVALIDATE_SUBJECT,
      JSON.stringify(['post:1', { scopes: { redis: ['x:v2'] } }]),
    );
    await turns(20);
    expect(busts).toEqual([['post:1']]);
  });
});
