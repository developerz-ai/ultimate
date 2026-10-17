// The boot's invalidation subscribe races the bus's FIRST dial. In production every pod logged
// `cache.broadcast.subscribe-failed … the bus has not connected yet, and dial attempt N is in
// progress` at warn on attempts 1–2 and recovered within 1.3 s — 345 lines in three weeks, all of
// them noise in alerting. A refusal inside the bounded first-dial window is not an outage; one
// that outlasts it still is, and still warns.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { isolateTiers, noopPurgeDriver } from '@ultimat3/cache';
import { logger, UltimateError } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import { DEFAULT_CACHE_TIERS, startCacheTiers } from './runtime-cache';

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
function dialingTransport(): { transport: Transport; attempts: () => number; up: () => void } {
  const inner = new InProcessTransport();
  let attempts = 0;
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
      return inner.subscribe(subject, handler);
    },
  };
  return {
    transport,
    attempts: () => attempts,
    up: () => {
      isUp = true;
    },
  };
}

const until = async (done: () => boolean): Promise<void> => {
  for (let tick = 0; tick < 500 && !done(); tick += 1) await Bun.sleep(1);
};

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
      subscribeRetryMs: () => 1,
      firstDialGraceMs: 60_000,
    });
    await until(() => bus.attempts() >= 3);
    bus.up();
    const before = bus.attempts();
    await until(() => bus.attempts() > before);
    await Bun.sleep(5);

    expect(warns.filter((line) => line.startsWith('cache.broadcast.subscribe-failed'))).toEqual([]);
    expect(infos.filter((line) => line.startsWith('cache.broadcast.subscribe-failed'))).toEqual([]);
  });

  test('a bus still down after the window warns, and says when it recovered', async () => {
    restore = isolateTiers();
    const { warns, infos } = captured();
    const bus = dialingTransport();
    release = startCacheTiers({
      env: {},
      purge: noopPurgeDriver(),
      transport: bus.transport,
      tiers: DEFAULT_CACHE_TIERS,
      subscribeRetryMs: () => 1,
      firstDialGraceMs: 20,
    });
    await until(() => warns.includes('cache.broadcast.subscribe-failed'));
    expect(warns.filter((line) => line === 'cache.broadcast.subscribe-failed')).toHaveLength(1);
    bus.up();
    await until(() => infos.includes('cache.broadcast.subscribe-failed recovered'));
    expect(infos).toContain('cache.broadcast.subscribe-failed recovered');
  });
});
