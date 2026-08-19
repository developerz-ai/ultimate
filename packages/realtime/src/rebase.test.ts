import { describe, expect, test } from 'bun:test';
import { RebaseConflictError } from './errors';
import type { Row } from './json';
import { type LocalTx, MemoryLocalStore } from './local-store';
import { custom, RebaseLog, rebaseFrame, reconcile, type ServerAck } from './rebase';
import { PROTOCOL_VERSION } from './sync-protocol';

/** The table map a generated app produces from its entities: `tx.posts`, not `tx['posts']`. */
type Tables = { posts: Row };

interface Fixture {
  store: MemoryLocalStore<Tables>;
  log: RebaseLog<Tables>;
}

/** Two optimistic likes on one post, neither acknowledged yet. */
function optimistic(): Fixture {
  const store = new MemoryLocalStore<Tables>({ posts: [{ id: 'p1', likes: 1, updatedAt: 10 }] });
  const log = new RebaseLog<Tables>();
  const bump = (key: string, seq: number) => {
    const apply = (tx: LocalTx<Tables>) => {
      tx.posts.update('p1', (row) => ({ likes: Number(row['likes'] ?? 0) + 1 }));
    };
    log.record({ key, seq, entity: 'posts', strategy: 'server-wins', apply });
    store.apply(key, apply);
  };
  bump('like:a', 1);
  bump('like:b', 2);
  return { store, log };
}

describe('rebase', () => {
  test('server-wins rolls back optimistic state and reapplies it in sequence order', () => {
    const { store, log } = optimistic();
    expect(store.table('posts').get('p1')?.['likes']).toBe(3);

    // The server acknowledges the first mutation only, and its truth disagrees with the client:
    // someone else liked the post too.
    const result = reconcile({
      store,
      log,
      ack: { key: 'like:a', entity: 'posts', id: 'p1', row: { id: 'p1', likes: 5, updatedAt: 20 } },
    });

    expect(result.strategy).toBe('server-wins');
    expect(result.winner).toBe('server');
    expect(result.rolledBack).toEqual(['like:b', 'like:a']);
    expect(result.reapplied).toEqual(['like:b']);
    // 5 from the server, plus the one mutation still in flight — never 3, never 7.
    expect(store.table('posts').get('p1')?.['likes']).toBe(6);
    expect(log.size).toBe(1);
  });

  test('an acked mutation leaves the log and stops being optimistic', () => {
    const { store, log } = optimistic();
    reconcile({
      store,
      log,
      ack: { key: 'like:a', entity: 'posts', id: 'p1', row: { id: 'p1', likes: 5 } },
    });
    expect(log.get('like:a')).toBeUndefined();
    expect(store.pendingKeys()).toEqual(['like:b']);
  });

  test('last-write-wins keeps the newer side by the server clock field', () => {
    const store = new MemoryLocalStore<Tables>({ posts: [{ id: 'p1', likes: 1, updatedAt: 99 }] });
    const log = new RebaseLog<Tables>();
    log.record({
      key: 'edit:a',
      seq: 1,
      entity: 'posts',
      strategy: 'last-write-wins',
      apply: () => undefined,
    });

    const result = reconcile({
      store,
      log,
      ack: { key: 'edit:a', entity: 'posts', id: 'p1', row: { id: 'p1', likes: 4, updatedAt: 20 } },
    });

    expect(result.winner).toBe('local');
    expect(store.table('posts').get('p1')?.['likes']).toBe(1);
  });

  test('custom(merge) that resolves nothing is a typed conflict, never a silent overwrite', () => {
    const store = new MemoryLocalStore<Tables>({ posts: [{ id: 'p1', likes: 1 }] });
    const log = new RebaseLog<Tables>();
    log.record({
      key: 'edit:a',
      seq: 1,
      entity: 'posts',
      strategy: custom(() => undefined),
      apply: () => undefined,
    });

    expect(() =>
      reconcile({
        store,
        log,
        ack: { key: 'edit:a', entity: 'posts', id: 'p1', row: { id: 'p1', likes: 4 } },
      }),
    ).toThrow(RebaseConflictError);
  });

  test('custom(merge) receives local, base, and server', () => {
    const store = new MemoryLocalStore<Tables>({ posts: [{ id: 'p1', likes: 1 }] });
    const log = new RebaseLog<Tables>();
    log.record({
      key: 'edit:a',
      seq: 1,
      entity: 'posts',
      strategy: custom(({ local, server }) => ({
        id: 'p1',
        likes: Number(local?.['likes'] ?? 0) + Number(server?.['likes'] ?? 0),
      })),
      apply: () => undefined,
    });

    const result = reconcile({
      store,
      log,
      ack: { key: 'edit:a', entity: 'posts', id: 'p1', row: { id: 'p1', likes: 4 } },
    });

    expect(result.winner).toBe('merge');
    expect(store.table('posts').get('p1')?.['likes']).toBe(5);
  });
});

describe('rebaseFrame', () => {
  const ack: ServerAck = {
    key: 'like:p1',
    entity: 'posts',
    id: 'p1',
    row: { id: 'p1', likes: 7, updatedAt: 30 },
  };

  test('carries the acked row and the strategy NAME, never the merge function', () => {
    const frame = rebaseFrame(ack, 'server-wins');
    expect(frame).toEqual({
      type: 'rebase',
      v: PROTOCOL_VERSION,
      key: 'like:p1',
      entity: 'posts',
      strategy: 'server-wins',
      row: { id: 'p1', likes: 7, updatedAt: 30 },
    });
    // It has to survive the wire: a closure would not.
    expect(JSON.parse(JSON.stringify(frame))).toEqual(frame as unknown as Record<string, unknown>);
  });

  test('a custom merge is named, not serialized', () => {
    const frame = rebaseFrame(
      ack,
      custom(({ server }) => server),
    );
    expect(frame.strategy).toBe('custom');
    expect(JSON.stringify(frame)).not.toContain('function');
  });

  test('last-write-wins keeps its own name', () => {
    expect(rebaseFrame(ack, 'last-write-wins').strategy).toBe('last-write-wins');
  });

  test('a delete is a null row, which is what tells the client to drop it', () => {
    const frame = rebaseFrame({ ...ack, row: null }, 'server-wins');
    expect(frame.row).toBe(null);
    expect(Object.hasOwn(frame, 'row')).toBe(true);
  });
});
