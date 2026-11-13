// The boot's invalidation subscribe races the bus's FIRST dial. In production every pod logged
// `cache.broadcast.subscribe-failed … the bus has not connected yet, and dial attempt N is in
// progress` at warn on attempts 1–2 and recovered within 1.3 s — 345 lines in three weeks, all of
// them noise in alerting. A refusal inside the bounded first-dial window is not an outage; one
// that outlasts it still is, and still warns.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  invalidateTags,
  isolateTiers,
  noopPurgeDriver,
  registeredTiers,
  resetTiers,
} from '@ultimat3/cache';
import { logger, UltimateError } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { DEFAULT_CACHE_TIERS, startCacheTiers } from './runtime-cache';
import { turn, turns, untilTurn } from './runtime-turns-fixture';

let release: (() => Promise<void>) | undefined;
let restore: (() => void) | undefined;
const spies: { mockRestore(): void }[] = [];

afterEach(async () => {
  await release?.();
  release = undefined;
  restore?.();
  restore = undefined;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** A bus that refuses until `up()` — a first dial still in progress. */
function dialingTransport(): {
  transport: Transport;
  attempts: () => number;
  landed: () => number;
  up: () => void;
} {
  const inner = new InProcessTransport();
  let attempts = 0;
  let landed = 0;
  let isUp = false;
  const transport: Transport = {
    name: 'dialing',
    shared: inner.shared,
    publish: (subject, payload) => inner.publish(subject, payload),
    close: () => inner.close(),
    onReconnect: () => inner.onReconnect(),
    async subscribe(subject, handler) {
      attempts += 1;
      if (!isUp) {
        throw new UltimateError({
          code: 'X_TRANSPORT_UNAVAILABLE',
          cause: 'the bus has not connected yet, and dial attempt 1 is in progress',
          fix: 'bun test packages/cli/src/runtime-cache-first-dial.test.ts',
        });
      }
      const subscription = await inner.subscribe(subject, handler);
      landed += 1;
      return subscription;
    },
  };
  return {
    transport,
    attempts: () => attempts,
    landed: () => landed,
    up: () => {
      isUp = true;
    },
  };
}

function captured(): { readonly warns: string[]; readonly infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  spies.push(spyOn(logger, 'warn').mockImplementation((line) => void warns.push(line)));
  spies.push(spyOn(logger, 'info').mockImplementation((line) => void infos.push(line)));
  return { warns, infos };
}

describe('unit · the boot subscribe during the first dial', () => {
  test('refusals inside the first-dial window are silent, recovery included', async () => {
    restore = isolateTiers();
    const { warns, infos } = captured();
    const bus = dialingTransport();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
      subscribeRetryWait: () => turn(),
      firstDialGraceMs: 60_000,
      // Frozen: the whole test runs inside the window, however slow the runner.
      monotonicNow: () => 0,
    });
    await untilTurn(() => bus.attempts() >= 3, 'three refused subscribes');
    // The window was exercised: the subscribe was refused, more than once, before the bus came up.
    expect(bus.attempts()).toBeGreaterThanOrEqual(3);
    expect(bus.landed()).toBe(0);
    bus.up();
    await untilTurn(() => bus.landed() > 0, 'the subscribe lands');
    // Twenty more turns: a loop still failing, or a late line, would show by now.
    await turns(20);

    // And it ended in a real subscription, not a loop still failing in silence.
    expect(bus.landed()).toBe(1);
    expect(warns.filter((line) => line.startsWith('cache.broadcast.subscribe-failed'))).toEqual([]);
    expect(infos.filter((line) => line.startsWith('cache.broadcast.subscribe-failed'))).toEqual([]);
  });

  test('a bus still down after the window warns, and says when it recovered', async () => {
    let elapsed = 0;
    restore = isolateTiers();
    const { warns, infos } = captured();
    const bus = dialingTransport();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
      subscribeRetryWait: () => turn(),
      firstDialGraceMs: 20,
      monotonicNow: () => elapsed,
    });
    // Inside the window: refused, and silent.
    await untilTurn(() => bus.attempts() >= 3, 'three refused subscribes');
    expect(warns).toEqual([]);
    // The window passes: the next refusal is an outage, and says so once.
    elapsed = 20;
    await untilTurn(() => warns.includes('cache.broadcast.subscribe-failed'), 'the outage warning');
    expect(warns.filter((line) => line === 'cache.broadcast.subscribe-failed')).toHaveLength(1);
    bus.up();
    await untilTurn(
      () => infos.includes('cache.broadcast.subscribe-failed recovered'),
      'the recovered line',
    );
    expect(infos).toContain('cache.broadcast.subscribe-failed recovered');
  });

  // A refused grace used to throw AFTER the tiers and the invalidation broadcaster were installed:
  // process-global state left registered with no release returned to drop it.
  test('a grace that is not a whole number refuses before anything is registered', async () => {
    restore = isolateTiers();
    resetTiers();
    for (const firstDialGraceMs of [Number.NaN, -1, 2.5]) {
      const bus = dialingTransport();
      let published = 0;
      const transport: Transport = {
        ...bus.transport,
        publish: (subject, payload) => {
          published += 1;
          return bus.transport.publish(subject, payload);
        },
      };
      expect(() =>
        startCacheTiers({
          env: {},
          purge: noopPurgeDriver(),
          transport,
          tiers: DEFAULT_CACHE_TIERS,
          subscribeRetryMs: () => 1,
          firstDialGraceMs,
        }),
      ).toThrow('firstDialGraceMs');
      expect(registeredTiers()).toEqual([]);
      // No broadcaster either: a local bust reaches no transport, and no subscribe was started.
      await invalidateTags([{ entity: 'post' }]);
      expect(published).toBe(0);
      expect(bus.attempts()).toBe(0);
    }
  });
});
