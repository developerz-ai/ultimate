// The edge, across a bus that goes away. A bust purges the CDN after it tells the peers — but a
// broadcast the bus REFUSED tells nobody: every peer still holds its copy, and each request one of
// them answers hands the just-purged edge the old page back. So the edge is purged when the bust
// runs AND again when the deferred broadcast is finally published, which is when the peers drop.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PurgeDriver } from '@ultimat3/cache';
import {
  invalidateTags,
  isolateDeclaredTags,
  isolateGraph,
  isolateTiers,
  tag,
} from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { FakeNatsBroker, fakeNatsConnect, selectTransport } from '@ultimat3/realtime/server';
import { CACHE_INVALIDATE_SUBJECT, DEFAULT_CACHE_TIERS, startCacheTiers } from './runtime-cache';

const NATS = { transport: 'nats', urlEnv: 'NATS_URL' } as const;
const ENV = { NATS_URL: 'nats://bus.test:4222' } as const;

let release: (() => Promise<void>) | undefined;
let transport: Transport | undefined;
let restores: (() => void)[] = [];
let printWarning = logger.warn;

beforeEach(() => {
  restores = [isolateTiers(), isolateDeclaredTags(), isolateGraph()];
  printWarning = logger.warn;
  logger.warn = (): void => undefined;
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

describe('a bust made while the bus is away, with an edge in front', () => {
  test('purges the edge with the bust, and again once the deferred broadcast is published', async () => {
    const broker = new FakeNatsBroker();
    /** Everything that happened, in order: an edge purge, or a peer hearing the bust. */
    const events: string[] = [];
    const edge: PurgeDriver = {
      name: 'spy',
      purge: (keys) => {
        events.push('edge');
        return Promise.resolve(keys);
      },
      purgeAll: () => Promise.resolve(),
    };
    const selection = selectTransport(ENV, NATS, {
      use: 'publish',
      connect: fakeNatsConnect(broker),
      backoff: { baseMs: 2, maxMs: 2, factor: 1, jitter: 'none' },
      onError: () => undefined,
    });
    transport = selection.transport;
    let landed = false;
    // A bus that does not echo: this replica hears NOTHING of its own publish, so an edge purge
    // after the reconnect can only be the sender's own, never its fan-out re-applied.
    const mute: Transport = {
      name: selection.transport.name,
      shared: selection.transport.shared,
      publish: (subject, payload) => selection.transport.publish(subject, payload),
      onReconnect: (listener) => selection.transport.onReconnect(listener),
      close: () => selection.transport.close(),
      async subscribe(subject) {
        const subscription = await selection.transport.subscribe(subject, () => undefined);
        landed = true;
        return subscription;
      },
    };
    await selection.connect();
    release = startCacheTiers({
      env: {},
      purge: edge,
      transport: mute,
      tiers: [...DEFAULT_CACHE_TIERS, 'cdn'],
      subscribeRetryMs: () => 1,
    });
    broker.client().subscribe(CACHE_INVALIDATE_SUBJECT, () => {
      events.push('peer-heard');
    });
    await until(() => landed);

    broker.drop();
    const report = await invalidateTags([tag('post', '1')]);
    expect(report.errors.map((entry) => entry.tier)).toEqual(['broadcast']);
    // Purged now, though no peer has been told: this origin's own page is gone already.
    expect(events).toEqual(['edge']);

    broker.restore();
    await until(() => events.filter((event) => event === 'edge').length >= 2);
    expect(events).toEqual(['edge', 'peer-heard', 'edge']);
  });
});
