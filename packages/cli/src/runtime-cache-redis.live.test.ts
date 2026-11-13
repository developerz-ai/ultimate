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
  redisPubSubAt,
  registerDependent,
  registeredTiers,
  registerRevalidator,
  tag,
} from '@ultimat3/cache';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { startCacheTiers } from './runtime-cache';

const url = Bun.env['TEST_REDIS_URL'];
const hasRedis = typeof url === 'string' && url.length > 0;
/**
 * Replica A, run as its own process (`bun -e`, inline as `registry-lazy.test.ts` does: a fixture
 * FILE only this live suite reaches is `X_COVERAGE_UNMEASURED` on a coverage run with no Redis).
 * It boots the hop on Redis with no NATS, busts one tag, and prints the report's errors.
 */
const PEER = `
const { declareTags, invalidateTags, noopPurgeDriver, parseTag } = await import('@ultimat3/cache');
const { InProcessTransport } = await import('@ultimat3/realtime/server');
const { startCacheTiers } = await import(${JSON.stringify(`${import.meta.dir}/runtime-cache.ts`)});
const [url, wire] = Bun.argv.slice(-2);
const bust = parseTag(wire);
declareTags([bust.entity]);
const release = startCacheTiers({
  env: { REDIS_URL: url },
  purge: noopPurgeDriver(),
  transport: new InProcessTransport(),
  tiers: ['lru'],
});
const report = await invalidateTags([bust]);
await release();
console.log(JSON.stringify(report.errors));
process.exit(0);
`;
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

/**
 * Polls the condition, one event-loop turn apart — the server and the peer answer when they do. A
 * condition that never holds fails NAMING what was waited on, never a bare `false` or a timeout.
 */
const until = async (what: string, done: () => Promise<boolean> | boolean): Promise<void> => {
  for (let poll = 0; poll < 2_000; poll += 1) {
    if (await done()) return;
    // real-clock: a real Redis server and a peer process deliver on their own time, not ours
    await Bun.sleep(1);
  }
  expect.unreachable(`still waiting for ${what} after 2,000 polls`);
};

/**
 * B's subscriber as the SERVER lists it, by its own `CLIENT SETNAME` — never a count of every
 * pub/sub connection: that raced the server reaping the sockets an earlier test closed, and any
 * suite running beside this one on the same Redis moved it.
 */
const connectionOf = async (name: string): Promise<{ id: string; sub: number } | undefined> => {
  const reply: unknown = await admin?.send('CLIENT', ['LIST', 'TYPE', 'pubsub']);
  for (const line of String(reply ?? '').split('\n')) {
    const fields = new Map(line.split(' ').map((pair) => pair.split('=', 2) as [string, string]));
    if (fields.get('name') !== name) continue;
    return { id: fields.get('id') ?? '', sub: Number(fields.get('sub') ?? '0') };
  }
  return undefined;
};

const subscribedAs = async (name: string): Promise<boolean> =>
  ((await connectionOf(name))?.sub ?? 0) > 0;

/** Replica B: an `lru` rung holding the post, and its ISR page registered on the same tag. */
async function replicaB(): Promise<{ lru: CacheTier; revalidated: string[]; name: string }> {
  declareTags(['post']);
  const revalidated: string[] = [];
  registerRevalidator((path) => {
    revalidated.push(path);
  });
  // One name per replica, so a rerun in this same process never finds the last one's socket.
  const name = `x-cache-bus-live:${String(process.pid)}:${crypto.randomUUID()}`;
  release = startCacheTiers({
    env: { REDIS_URL: url ?? '' },
    purge: noopPurgeDriver(),
    transport: new InProcessTransport(),
    tiers: ['lru'],
    redisPubSub: (at) => redisPubSubAt(at, { connectionName: name }),
  });
  const lru = registeredTiers().find((tier) => tier.name === 'lru');
  if (lru === undefined) return expect.unreachable('cache.tiers named lru');
  await until(`B's subscriber ${name} subscribed (CLIENT LIST TYPE pubsub)`, () =>
    subscribedAs(name),
  );
  await lru.set(KEY, { title: 'old' }, { tags: [tag('post', '1')], ttlMs: 60_000 });
  registerDependent([tag('post', '1')], { kind: 'isr-route', id: PAGE });
  return { lru, revalidated, name };
}

/** Replica A: a separate process busting `post:1`, as an action's `invalidates` would. */
async function writeOnA(): Promise<void> {
  const child = Bun.spawn(['bun', '-e', PEER, url ?? '', 'post:1'], {
    // The cli workspace, where `@ultimat3/cache` and `@ultimat3/realtime` resolve; the root has neither.
    cwd: `${import.meta.dir}/..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
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

    await until(
      `B's lru to drop ${KEY} on A's bust`,
      async () => (await b.lru.get(KEY)) === undefined,
    );
    await until(`B to revalidate ${PAGE} on A's bust`, () => b.revalidated.includes(PAGE));
  });

  test('a dropped subscription is restored, and what B held while deaf is dropped', async () => {
    const b = await replicaB();
    // B's connection only, by the id its name maps to: the server forgets the subscription. Every
    // pub/sub connection would cut a suite running beside this one on the same Redis too.
    const killed = await connectionOf(b.name);
    if (killed === undefined) return expect.unreachable(`B's subscriber ${b.name} listed`);
    await admin?.send('CLIENT', ['KILL', 'ID', killed.id]);

    // Nobody busted `post:1`; B cannot know what it missed, so its own heap goes cold.
    await until(
      `B's lru to drop ${KEY} after its resubscribe`,
      async () => (await b.lru.get(KEY)) === undefined,
    );
    await until(`B's subscriber ${b.name} back on a new connection`, async () => {
      const now = await connectionOf(b.name);
      return now !== undefined && now.id !== killed.id && now.sub > 0;
    });

    // Resubscribed: the next write on A still reaches it.
    b.revalidated.length = 0;
    await b.lru.set(KEY, { title: 'refilled' }, { tags: [tag('post', '1')], ttlMs: 60_000 });
    await writeOnA();
    await until(
      `B's lru to drop the refilled ${KEY} on A's bust`,
      async () => (await b.lru.get(KEY)) === undefined,
    );
  });
});
