// The invalidation hop across a bus that goes away. A publish with no live connection is refused
// (`NatsTransport`), so a bust made during a NATS restart reached no peer — and a process whose own
// connection was down heard none of its peers' busts either, with nothing to say which. Both are
// repaired when the bus returns: the sender publishes what was refused, and every process drops
// what it holds in its own heap, because it was deaf for a window nobody measured.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  invalidateTags,
  isolateDeclaredTags,
  isolateGraph,
  isolateTiers,
  noopPurgeDriver,
  registerDependent,
  registeredTiers,
  registerRevalidator,
  tag,
} from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { FakeNatsBroker, fakeNatsConnect, selectTransport } from '@ultimat3/realtime/server';
import {
  CACHE_FLUSH_ALL,
  CACHE_INVALIDATE_SUBJECT,
  DEFAULT_CACHE_TIERS,
  MAX_DEFERRED_TAGS,
  startCacheTiers,
} from './runtime-cache';

const NATS = { transport: 'nats', urlEnv: 'NATS_URL' } as const;
const ENV = { NATS_URL: 'nats://bus.test:4222' } as const;

let release: (() => Promise<void>) | undefined;
let transport: Transport | undefined;
let restores: (() => void)[] = [];
const warnings: { line: string; meta: Record<string, unknown> | undefined }[] = [];
let printWarning = logger.warn;

beforeEach(() => {
  restores = [isolateTiers(), isolateDeclaredTags(), isolateGraph()];
  printWarning = logger.warn;
  warnings.length = 0;
  logger.warn = (line: string, meta?: Record<string, unknown>): void => {
    warnings.push({ line, meta });
  };
});

afterEach(async () => {
  await release?.();
  release = undefined;
  await transport?.close();
  transport = undefined;
  for (const restore of restores) restore();
  logger.warn = printWarning;
});

const until = async (done: () => boolean, polls = 500): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(2);
};

/** This process as one replica: a web role's bus (background dial) with the cache hop on top. */
async function replica(broker: FakeNatsBroker, retryMs: (attempt: number) => number = () => 1) {
  const selection = selectTransport(ENV, NATS, {
    use: 'publish',
    connect: fakeNatsConnect(broker),
    backoff: { baseMs: 2, maxMs: 2, factor: 1, jitter: 'none' },
    onError: () => undefined,
  });
  transport = selection.transport;
  let subscribes = 0;
  let landed = 0;
  const counted: Transport = {
    name: selection.transport.name,
    shared: selection.transport.shared,
    publish: (subject, payload) => selection.transport.publish(subject, payload),
    onReconnect: (listener) => selection.transport.onReconnect(listener),
    close: () => selection.transport.close(),
    async subscribe(subject, handler) {
      subscribes += 1;
      const subscription = await selection.transport.subscribe(subject, handler);
      landed += 1;
      return subscription;
    },
  };
  await selection.connect();
  release = startCacheTiers({
    env: {},
    purge: noopPurgeDriver(),
    transport: counted,
    tiers: DEFAULT_CACHE_TIERS,
    subscribeRetryMs: retryMs,
  });
  const lru = registeredTiers().find((tier) => tier.name === 'lru');
  if (lru === undefined) expect.unreachable('the default ladder has an lru tier');
  return { selection, lru, subscribes: () => subscribes, landed: () => landed };
}

/** Another replica, as the bus sees it: what it is sent, and what it sends. */
function peer(broker: FakeNatsBroker) {
  const client = broker.client();
  const heard: string[] = [];
  client.subscribe(CACHE_INVALIDATE_SUBJECT, (message) => {
    heard.push(new TextDecoder().decode(message.payload));
  });
  return {
    heard,
    bust: (payload: string): void => {
      client.publish(CACHE_INVALIDATE_SUBJECT, new TextEncoder().encode(payload));
    },
  };
}

describe('a bust made while the bus is away', () => {
  test('is kept, de-duplicated, and published when the bus returns', async () => {
    const broker = new FakeNatsBroker();
    const self = await replica(broker);
    const other = peer(broker);
    await until(() => self.landed() === 1);

    broker.drop();
    const report = await invalidateTags([tag('post', '1')]);
    await invalidateTags([tag('post', '1'), tag('post', '2')]);
    // Still an error on the report: the peers have NOT been told yet.
    expect(report.errors.map((entry) => entry.tier)).toEqual(['broadcast']);
    expect(other.heard).toEqual([]);

    broker.restore();
    await until(() => other.heard.length >= 1);
    await Bun.sleep(10);

    expect(other.heard).toEqual(['["post:1","post:2"]']);
  });

  test('past the bound it is ONE flush-all, not a queue: nothing grows with the outage', async () => {
    const broker = new FakeNatsBroker();
    const self = await replica(broker);
    const other = peer(broker);
    await until(() => self.landed() === 1);

    broker.drop();
    for (let id = 0; id <= MAX_DEFERRED_TAGS; id += 1) await invalidateTags([tag('post', `${id}`)]);
    // And long after the bound was passed: still nothing kept per bust.
    for (let id = 0; id < 50; id += 1) await invalidateTags([tag('comment', `${id}`)]);

    broker.restore();
    await until(() => other.heard.length >= 1);
    await Bun.sleep(10);

    expect(other.heard).toEqual([CACHE_FLUSH_ALL]);
  });

  test('a publish that lands later also carries what an earlier one could not', async () => {
    const broker = new FakeNatsBroker();
    const self = await replica(broker);
    const other = peer(broker);
    await until(() => self.landed() === 1);

    // Refused by the bus itself, with the connection up: no reconnect will ever announce it.
    const publish = self.selection.transport.publish.bind(self.selection.transport);
    let refuse = true;
    self.selection.transport.publish = async (subject, payload) => {
      if (refuse) return await Promise.reject(new RangeError('max_payload exceeded'));
      await publish(subject, payload);
    };
    await invalidateTags([tag('post', '1')]);
    refuse = false;
    await invalidateTags([tag('post', '2')]);
    await until(() => other.heard.length >= 2);

    expect(other.heard).toEqual(['["post:2"]', '["post:1"]']);
  });
});

describe('a replica whose own connection was down', () => {
  test('drops what it cached while deaf, and marks its tagged ISR pages stale, when the bus returns', async () => {
    const broker = new FakeNatsBroker();
    const self = await replica(broker);
    const other = peer(broker);
    await until(() => self.landed() === 1);
    registerDependent([tag('post')], { kind: 'isr-route', id: '/blog' });
    const marked: string[] = [];
    registerRevalidator((path) => {
      marked.push(path);
    });

    broker.drop();
    await self.lru.set('post:1', 'stale', { tags: [tag('post', '1')] });
    // The peer edits the post. This replica cannot hear it, and nobody will repeat it.
    other.bust('["post:1"]');
    await Bun.sleep(5);
    expect((await self.lru.get('post:1'))?.value).toBe('stale');
    expect(marked).toEqual([]);

    broker.restore();
    await until(() => marked.length > 0);

    expect(await self.lru.get('post:1')).toBeUndefined();
    expect(marked).toEqual(['/blog']);
  });

  test("a peer's flush-all empties this replica too", async () => {
    const broker = new FakeNatsBroker();
    const self = await replica(broker);
    const other = peer(broker);
    await until(() => self.landed() === 1);
    await self.lru.set('anything', 1);

    other.bust(CACHE_FLUSH_ALL);
    await Bun.sleep(40);

    expect(await self.lru.get('anything')).toBeUndefined();
  });
});

describe('the invalidation subscribe of a role booted with the bus down', () => {
  // The key property of a publisher that does not wait for the bus: it must still end up
  // SUBSCRIBED, or it is a replica that never hears a peer again.
  test("is refused while offline, lands once when the bus is up, and then delivers a peer's bust", async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const self = await replica(broker);
    await until(() => self.subscribes() >= 3);
    expect(self.subscribes()).toBeGreaterThanOrEqual(3);
    expect(self.landed()).toBe(0);
    await self.lru.set('post:1', 'old', { tags: [tag('post', '1')] });

    broker.offline = false;
    await until(() => self.landed() === 1);
    const attempts = self.subscribes();
    await Bun.sleep(20);
    // One that lands, then none.
    expect(self.landed()).toBe(1);
    expect(self.subscribes()).toBe(attempts);
    // It was deaf since boot: what it cached meanwhile is not trusted.
    expect(await self.lru.get('post:1')).toBeUndefined();

    await self.lru.set('post:1', 'old', { tags: [tag('post', '1')] });
    peer(broker).bust('["post:1"]');
    await Bun.sleep(40);
    expect(await self.lru.get('post:1')).toBeUndefined();
  });

  test('is woken by the bus coming up, not by its own backoff', async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const self = await replica(broker, () => 60_000);
    await until(() => self.subscribes() >= 1);

    const startedAt = performance.now();
    broker.offline = false;
    await until(() => self.landed() === 1);

    expect(self.landed()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test('warns on attempts 1, 2, 4, 8 — not once per retry for as long as the outage lasts', async () => {
    const broker = new FakeNatsBroker();
    broker.offline = true;
    const self = await replica(broker, () => 0);
    await until(() => self.subscribes() >= 20);

    const attempts = warnings
      .filter((warning) => warning.line === 'cache.broadcast.subscribe-failed')
      .map((warning) => warning.meta?.['attempt']);
    expect(attempts.slice(0, 4)).toEqual([1, 2, 4, 8]);
    expect(attempts.length).toBeLessThanOrEqual(Math.ceil(Math.log2(self.subscribes())) + 1);
  });
});
