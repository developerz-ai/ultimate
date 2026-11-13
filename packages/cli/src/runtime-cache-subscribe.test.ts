// The inbound half of cross-replica invalidation is a subscription made at boot, without blocking
// the boot. A bus that refused that ONE subscribe was logged once and never asked again, so the
// process missed every peer's bust for the rest of its life (s1-con #8, narrowed in s3-be).

import { afterEach, describe, expect, test } from 'bun:test';
import { isolateTiers, noopPurgeDriver } from '@ultimat3/cache';
import { UltimateError } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { DEFAULT_CACHE_TIERS, startCacheTiers } from './runtime-cache';
import { turn, turns, untilTurn } from './runtime-turns-fixture';

let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;

afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  restore = undefined;
});

/** A bus whose first `refusals` subscribes reject — a NATS server still starting, say. */
function flakyTransport(refusals: number): { transport: Transport; attempts: () => number } {
  const inner = new InProcessTransport();
  let attempts = 0;
  const transport: Transport = {
    name: 'flaky',
    shared: inner.shared,
    publish: (subject, payload) => inner.publish(subject, payload),
    close: () => inner.close(),
    onReconnect: () => inner.onReconnect(),
    async subscribe(subject, handler) {
      attempts += 1;
      if (attempts <= refusals) {
        throw new UltimateError({
          code: 'X_TRANSPORT_UNAVAILABLE',
          cause: 'the flaky test bus refuses this subscribe',
          fix: 'bun test packages/cli/src/runtime-cache-subscribe.test.ts',
        });
      }
      return inner.subscribe(subject, handler);
    },
  };
  return { transport, attempts: () => attempts };
}

describe('unit · the invalidation subscribe is retried', () => {
  test('two refusals, then the third subscribe is made — and no fourth', async () => {
    restore = isolateTiers();
    const bus = flakyTransport(2);
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
      subscribeRetryWait: () => turn(),
    });
    await untilTurn(() => bus.attempts() >= 3, 'the third subscribe');
    // Twenty more turns, each a whole retry wait: a fourth subscribe would have been made by now.
    await turns(20);
    expect(bus.attempts()).toBe(3);
  });

  test('a release mid-backoff ends the retry, without waiting out the delay', async () => {
    restore = isolateTiers();
    const bus = flakyTransport(Number.POSITIVE_INFINITY);
    const stop = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
      // A delay that never ends on its own: only the release can end the wait.
      subscribeRetryWait: () => new Promise(() => undefined),
    });
    await untilTurn(() => bus.attempts() >= 1, 'the first refused subscribe');
    await stop();
    expect(bus.attempts()).toBe(1);
  });
});
