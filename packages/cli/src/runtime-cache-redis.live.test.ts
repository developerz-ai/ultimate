// Rung 1 of the scale ladder — roles split, Redis, no NATS — with two web replicas. The hop used to
// ride the in-process bus there, so a write on one replica left the other serving its stale page
// and its stale `cache:` read until the TTL. Two real processes on one real Redis: a bust on A
// (a child process) reaches B (this one), and B, cut off and reconnected, drops what it held.
//
// Skips unless a Redis is configured: `docker compose -f docker/docker-compose.test.yml up -d
// --wait redis`, then `set -a; . docker/test-services.env; set +a`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import {
  declareTags,
  isolateDeclaredTags,
  isolateGraph,
  isolateTiers,
  noopPurgeDriver,
  registerDependent,
  registeredTiers,
  registerRevalidator,
  tag,
} from '@ultimat3/cache';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { CACHE_INVALIDATE_SUBJECT, startCacheTiers } from './runtime-cache';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;
const PEER = `${import.meta.dir}/runtime-cache-redis-peer-fixture.ts`;
const KEY = 'live:post:1';
const PAGE = '/posts/1';

let release: (() => Promise<void>) | undefined;
let restores: (() => void)[] = [];
const admin = hasRedis ? new Bun.RedisClient(url ?? '') : undefined;

beforeEach(() => {
  restores = [isolateTiers(), isolateDeclaredTags(), isolateGraph()];
});

afterEach(async () => {
  await release?.();
  release = undefined;
  for (const restore of restores) restore();
  registerRevalidator(() => undefined);
});

/** Polls the condition, one event-loop turn apart — the server and the peer answer when they do. */
const until = async (done: () => Promise<boolean> | boolean, polls = 5_000): Promise<boolean> => {
  for (let poll = 0; poll < polls; poll += 1) {
    if (await done()) return true;
    // real-clock: a real Redis server and a peer process deliver on their own time, not ours
    await Bun.sleep(1);
  }
  return false;
};

/** How many connections the server holds subscribed to the hop's channel. */
const subscribers = async (): Promise<number> => {
  const reply: unknown = await admin?.send('PUBSUB', ['NUMSUB', CACHE_INVALIDATE_SUBJECT]);
  return Array.isArray(reply) ? Number(reply[1]) : 0;
};

/** Replica B: an `lru` rung holding the post, and its ISR page registered on the same tag. */
async function replicaB(): Promise<{ lru: CacheTier; revalidated: string[] }> {
  declareTags(['post']);
  const revalidated: string[] = [];
  registerRevalidator((path) => {
    revalidated.push(path);
  });
  const before = await subscribers();
  release = startCacheTiers({
    env: { REDIS_URL: url ?? '' },
    purge: noopPurgeDriver(),
    transport: new InProcessTransport(),
    tiers: ['lru'],
  });
  const lru = registeredTiers().find((tier) => tier.name === 'lru');
  if (lru === undefined) return expect.unreachable('cache.tiers named lru');
  expect(await until(async () => (await subscribers()) > before)).toBe(true);
  await lru.set(KEY, { title: 'old' }, { tags: [tag('post', '1')], ttlMs: 60_000 });
  registerDependent([tag('post', '1')], { kind: 'isr-route', id: PAGE });
  return { lru, revalidated };
}

/** Replica A: a separate process busting `post:1`, as an action's `invalidates` would. */
async function writeOnA(): Promise<void> {
  const child = Bun.spawn(['bun', PEER, url ?? '', 'post:1'], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  // No `broadcast` error: A's publish was accepted by Redis.
  expect(JSON.parse(out.trim().split('\n').at(-1) ?? 'null')).toEqual([]);
}

describe.skipIf(!hasRedis)('live · cache invalidation over Redis pub/sub, no NATS', () => {
  test('a write on replica A drops the cached read and the ISR page on replica B', async () => {
    const b = await replicaB();
    expect(await b.lru.get(KEY)).toBeDefined();

    await writeOnA();

    expect(await until(async () => (await b.lru.get(KEY)) === undefined)).toBe(true);
    expect(await until(() => b.revalidated.includes(PAGE))).toBe(true);
  });

  test('a dropped subscription is restored, and what B held while deaf is dropped', async () => {
    const b = await replicaB();
    // Every pub/sub connection on the server, B's included: the server forgets the subscription.
    await admin?.send('CLIENT', ['KILL', 'TYPE', 'pubsub']);

    // Nobody busted `post:1`; B cannot know what it missed, so its own heap goes cold.
    expect(await until(async () => (await b.lru.get(KEY)) === undefined)).toBe(true);
    expect(await until(async () => (await subscribers()) > 0)).toBe(true);

    // Resubscribed: the next write on A still reaches it.
    b.revalidated.length = 0;
    await b.lru.set(KEY, { title: 'refilled' }, { tags: [tag('post', '1')], ttlMs: 60_000 });
    await writeOnA();
    expect(await until(async () => (await b.lru.get(KEY)) === undefined)).toBe(true);
  });
});
