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
import { turn, turnScheduler, untilTurn } from './runtime-turns-fixture';

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
    const selection = selectTransport(ENV, {
      use: 'publish',
      connect: fakeNatsConnect(broker),
      backoff: { base: 2, max: 2, factor: 1, jitter: 'none' },
      // Each re-dial waits one loop turn, not 2 ms.
      scheduler: turnScheduler,
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
      subscribeRetryWait: () => turn(),
    });
    broker.client().subscribe(CACHE_INVALIDATE_SUBJECT, () => {
      events.push('peer-heard');
    });
    await untilTurn(() => landed, 'the subscribe lands');

    broker.drop();
    const report = await invalidateTags([tag('post', '1')]);
    expect(report.errors.map((entry) => entry.tier)).toEqual(['broadcast']);
    // Purged now, though no peer has been told: this origin's own page is gone already.
    expect(events).toEqual(['edge']);

    broker.restore();
    await untilTurn(
      () => events.filter((event) => event === 'edge').length >= 2,
      'the second edge purge',
    );
    expect(events).toEqual(['edge', 'peer-heard', 'edge']);
  });
});
