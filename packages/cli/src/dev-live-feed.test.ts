// What feeds a sync node, decided by the database and never by guessing. The booted half — a real
// subscription on the real node under the embedded database, one repository write, one patch —
// lives in `cmd-dev.test.ts`, because a process has ONE lifecycle and that file owns the boot.
import { describe, expect, test } from 'bun:test';
import { rowObserver } from '@ultimat3/entity';
import { liveFeedLabel, startLiveFeed } from './dev-live-feed';

describe('startLiveFeed decides by the database, never by guessing', () => {
  test('no sync node is no feed; a real database is the WAL decoder, with no bridge beside it', async () => {
    const none = await startLiveFeed({ sync: null, dbMode: 'embedded' });
    expect(none.feed).toBe('none');
    const external = await startLiveFeed({
      sync: { url: 'ws://x', registry: {} as never, stop: async () => undefined },
      dbMode: 'external',
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
        stop: async () => undefined,
      },
      dbMode: 'embedded',
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
    const before = rowObserver();
    const live = await startLiveFeed({
      sync: { url: 'ws://x', registry, stop: async () => undefined },
      dbMode: 'embedded',
    });
    try {
      rowObserver()?.onChange({ entity: 'notes', op: 'insert', before: null, after: { id: 'n1' } });
      rowObserver()?.onChange({ entity: 'notes', op: 'insert', before: null, after: { id: 'n2' } });
      await live.bridge?.settled();
      // Both were attempted: the first failure did not silence the change behind it.
      expect(attempts).toBe(2);
      expect(live.bridge?.delivered).toBe(0);
    } finally {
      live.stop();
    }
    expect(rowObserver()).toBe(before);
  });
});
