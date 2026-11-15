// What a process owes the bus after a refused bust, settled when it returns: one batch published
// once however many reconnects ask, a refusal mid-settle still owed, and one refused settle logged
// as one failure. Split from `runtime-cache-bus-loss.test.ts`; both drive `startCacheTiers`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  invalidateTags,
  isolateDeclaredTags,
  isolateGraph,
  isolateTiers,
  noopPurgeDriver,
  tag,
} from '@ultimat3/cache';
import { logger } from '@ultimat3/core';
import type { Transport } from '@ultimat3/realtime/server';
import { InProcessTransport } from '@ultimat3/realtime/server';
import {
  CACHE_FLUSH_ALL,
  DEFAULT_CACHE_TIERS,
  MAX_DEFERRED_TAGS,
  startCacheTiers,
} from './runtime-cache';

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

/**
 * A bus held by hand: every publish waits for the test to accept or refuse it, and the reconnect
 * is the test's to announce — so two settles overlap exactly where the test says they do.
 */
function heldBus() {
  const inner = new InProcessTransport();
  const sends: { payload: string; accept(): void; refuse(): void }[] = [];
  const listeners = new Set<() => void>();
  const held: Transport = {
    name: 'held',
    shared: inner.shared,
    subscribe: (subject, handler) => inner.subscribe(subject, handler),
    close: () => inner.close(),
    onReconnect: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (_subject, payload) => {
      const gate = Promise.withResolvers<void>();
      sends.push({
        payload,
        accept: () => gate.resolve(),
        refuse: () => gate.reject(new RangeError('the bus refused the publish')),
      });
      return gate.promise;
    },
  };
  transport = held;
  release = startCacheTiers({
    env: {},
    purge: noopPurgeDriver(),
    transport: held,
    tiers: DEFAULT_CACHE_TIERS,
  });
  const turns = async (): Promise<void> => {
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
  };
  /** One bust the bus refuses: its tags are now owed. */
  const refusedBust = async (...ids: string[]): Promise<void> => {
    const busting = invalidateTags(ids.map((id) => tag('post', id)));
    await turns();
    sends.at(-1)?.refuse();
    await busting;
  };
  return {
    sends,
    turns,
    refusedBust,
    reconnect: (): void => {
      for (const listener of [...listeners]) listener();
    },
  };
}

// `settle` runs from the reconnect and after every accepted publish, and nothing serialized it:
// two that overlapped both read the same owed set and both published it, and one that was refused
// could leave the other's success clearing tags the bus never took.
describe('what is owed to the bus, settled by two callers at once', () => {
  test('one batch is published once, however many reconnects announce the bus', async () => {
    const bus = heldBus();
    await bus.refusedBust('1', '2');
    const before = bus.sends.length;

    bus.reconnect();
    bus.reconnect();
    bus.reconnect();
    await bus.turns();
    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual(['["post:1","post:2"]']);

    bus.sends.at(-1)?.accept();
    await bus.turns();
    // Nothing is owed any more, so the calls that arrived mid-flight publish nothing.
    expect(bus.sends).toHaveLength(before + 1);
  });

  test('one flush-all is published once', async () => {
    const bus = heldBus();
    const ids = Array.from({ length: MAX_DEFERRED_TAGS + 1 }, (_, id) => `${id}`);
    await bus.refusedBust(...ids);
    const before = bus.sends.length;

    bus.reconnect();
    bus.reconnect();
    await bus.turns();
    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual([CACHE_FLUSH_ALL]);
    bus.sends.at(-1)?.accept();
    await bus.turns();
    expect(bus.sends).toHaveLength(before + 1);
  });

  test('a batch refused mid-settle is still owed, and the next reconnect publishes it', async () => {
    const bus = heldBus();
    await bus.refusedBust('1');
    const before = bus.sends.length;

    bus.reconnect();
    await bus.turns();
    bus.sends.at(-1)?.refuse();
    await bus.turns();
    expect(warnings.map((warning) => warning.line)).toContain('cache.broadcast.deferred-failed');

    bus.reconnect();
    await bus.turns();
    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual([
      '["post:1"]',
      '["post:1"]',
    ]);
  });

  test('a settle refused on every reconnect is one line, and one more when it lands', async () => {
    const recovered: (Record<string, unknown> | undefined)[] = [];
    const info = spyOn(logger, 'info').mockImplementation((line, meta) => {
      if (line === 'cache.broadcast.deferred-recovered') recovered.push(meta);
    });
    try {
      const bus = heldBus();
      await bus.refusedBust('1');
      // A flapping bus: every reconnect's settle is refused, for the same reason.
      for (let flap = 0; flap < 5; flap += 1) {
        bus.reconnect();
        await bus.turns();
        bus.sends.at(-1)?.refuse();
        await bus.turns();
      }
      const failed = warnings.filter(
        (warning) => warning.line === 'cache.broadcast.deferred-failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.meta?.['error']).toContain('the bus refused the publish');
      expect(recovered).toEqual([]);

      bus.reconnect();
      await bus.turns();
      bus.sends.at(-1)?.accept();
      await bus.turns();
      expect(recovered).toEqual([{ failures: 5 }]);
    } finally {
      info.mockRestore();
    }
  });

  test('one refused settle is one failure, however many reconnects joined it', async () => {
    const recovered: (Record<string, unknown> | undefined)[] = [];
    const info = spyOn(logger, 'info').mockImplementation((line, meta) => {
      if (line === 'cache.broadcast.deferred-recovered') recovered.push(meta);
    });
    try {
      const bus = heldBus();
      await bus.refusedBust('1');
      bus.reconnect();
      await bus.turns();
      // Three more reconnects while that settle's publish is in flight: joiners, not new runs.
      bus.reconnect();
      bus.reconnect();
      bus.reconnect();
      await bus.turns();
      bus.sends.at(-1)?.refuse();
      await bus.turns();

      bus.reconnect();
      await bus.turns();
      bus.sends.at(-1)?.accept();
      await bus.turns();
      expect(recovered).toEqual([{ failures: 1 }]);
    } finally {
      info.mockRestore();
    }
  });

  test('a flush-all refused mid-settle is still owed', async () => {
    const bus = heldBus();
    await bus.refusedBust(...Array.from({ length: MAX_DEFERRED_TAGS + 1 }, (_, id) => `${id}`));
    const before = bus.sends.length;

    bus.reconnect();
    await bus.turns();
    bus.sends.at(-1)?.refuse();
    await bus.turns();
    bus.reconnect();
    await bus.turns();

    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual([
      CACHE_FLUSH_ALL,
      CACHE_FLUSH_ALL,
    ]);
  });

  test('a tag refused while a settle is in flight is not lost: the run goes round again', async () => {
    const bus = heldBus();
    await bus.refusedBust('1');
    const before = bus.sends.length;

    bus.reconnect();
    await bus.turns();
    // The first batch is on the wire; a second bust is refused meanwhile, and the bus announced.
    const busting = invalidateTags([tag('post', '2')]);
    await bus.turns();
    bus.sends.at(-1)?.refuse();
    await busting;
    bus.reconnect();
    await bus.turns();
    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual([
      '["post:1"]',
      '["post:2"]',
    ]);

    // The batch already sent is accepted: only what it did not carry goes out next, once.
    bus.sends[before]?.accept();
    await bus.turns();
    expect(bus.sends.slice(before).map((send) => send.payload)).toEqual([
      '["post:1"]',
      '["post:2"]',
      '["post:2"]',
    ]);
  });
});
