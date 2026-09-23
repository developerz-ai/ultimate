// What feeds a sync node, decided by the database and never by guessing. The booted half — a real
// subscription on the real node under the embedded database, one repository write, one patch —
// lives in `cmd-dev.test.ts`, because a process has ONE lifecycle and that file owns the boot.
import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { rowObserver } from '@ultimat3/entity';
import { liveFeedLabel, startLiveFeed } from './runtime-live-feed';

describe('startLiveFeed decides by the database, never by guessing', () => {
  test('no sync node is no feed; a real database is the WAL decoder, with no bridge beside it', async () => {
    const none = await startLiveFeed({
      sync: null,
      dbMode: 'embedded',
      transport: 'in-process',
      replicatorHere: false,
    });
    expect(none.feed).toBe('none');
    const external = await startLiveFeed({
      sync: { url: 'ws://x', registry: {} as never, hub: {} as never, stop: async () => undefined },
      dbMode: 'external',
      transport: 'nats',
      replicatorHere: false,
    });
    expect(external.feed).toBe('replication');
    expect(external.bridge).toBeNull();
    // Neither installed anything, so stopping either is a no-op that leaves the observer alone.
    const before = rowObserver();
    none.stop();
    external.stop();
    expect(rowObserver()).toBe(before);
    expect(liveFeedLabel('in-process')).toBe('live=in-process');
  });

  test('the embedded database installs the bridge, and stop() hands the observer back', async () => {
    const before = rowObserver();
    const live = await startLiveFeed({
      sync: {
        url: 'ws://x',
        registry: { deliver: async () => 0, invalidate: () => 0 } as never,
        hub: { deliverChange: () => undefined } as never,
        stop: async () => undefined,
      },
      dbMode: 'embedded',
      transport: 'in-process',
      replicatorHere: false,
    });
    expect(live.feed).toBe('in-process');
    expect(live.bridge).not.toBeNull();
    expect(rowObserver()).not.toBe(before);
    live.stop();
    expect(rowObserver()).toBe(before);
  });

  test('a change nobody could fan out is logged and never takes the bridge down', async () => {
    let attempts = 0;
    const registry = {
      deliver: (): Promise<number> => {
        attempts += 1;
        return Promise.reject(new Error('fanout refused'));
      },
      invalidate: () => 0,
    } as never;
    // The node's channels ride the same bridge: without them no declared channel ever carried a
    // write made under `x dev`, and a second tab stayed on the old row.
    const channelled: unknown[] = [];
    const hub = { deliverChange: (change: unknown) => channelled.push(change) } as never;
    const before = rowObserver();
    const live = await startLiveFeed({
      sync: { url: 'ws://x', registry, hub, stop: async () => undefined },
      dbMode: 'embedded',
      transport: 'in-process',
      replicatorHere: false,
    });
    try {
      rowObserver()?.onChange({ entity: 'notes', op: 'insert', before: null, after: { id: 'n1' } });
      rowObserver()?.onChange({ entity: 'notes', op: 'insert', before: null, after: { id: 'n2' } });
      await live.bridge?.settled();
      // Both were attempted: the first failure did not silence the change behind it.
      expect(attempts).toBe(2);
      expect(live.bridge?.delivered).toBe(0);
      expect(channelled).toHaveLength(2);
    } finally {
      live.stop();
    }
    expect(rowObserver()).toBe(before);
  });
});

// A `sync` pod on a real database reported `feed: 'replication'` with no replicator it could hear:
// with NATS_URL unset, a replicator in another pod publishes into its own in-process bus, and
// every live query and channel here was dead with no error anywhere — the deployed demo's state.
describe('a split-role topology that cannot deliver a change', () => {
  const sync = {
    url: 'ws://x',
    registry: {} as never,
    hub: {} as never,
    stop: async () => undefined,
  };

  test('sync on an external database, in-process bus, no replicator here: refused at boot', async () => {
    const refused = await startLiveFeed({
      sync,
      dbMode: 'external',
      transport: 'in-process',
      replicatorHere: false,
    }).then(
      () => 'booted',
      (error: unknown) => (isUltimateError(error) ? error.code : 'not coded'),
    );
    expect(refused).toBe('X_REALTIME_TOPOLOGY');
  });

  test('a shared bus, or the replicator in this process, is a topology that delivers', async () => {
    for (const [transport, replicatorHere] of [
      ['nats', false],
      ['in-process', true],
    ] as const) {
      const live = await startLiveFeed({ sync, dbMode: 'external', transport, replicatorHere });
      expect(live.feed).toBe('replication');
    }
  });
});
