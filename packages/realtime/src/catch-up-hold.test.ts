// #778: a channel's catch-up read that answers BEFORE a pending write's echo. The write committed,
// the read's snapshot holds it, and adopted at once under the still-pending twin it painted the like
// twice until the echo or the HTTP answer settled it. The read now lands once the writes in flight
// over its types are answered or echoed — bounded by the store's one server wait.

import { describe, expect, test } from 'bun:test';
import { UltimateError, writeDigest } from '@ultimat3/core';
import type { CatchUpRecords } from './channel-catch-up';
import { ChannelBook } from './client-channels';
import { DEFAULT_AWAIT_SERVER_MS, RecordStore } from './record-store';
import type { LocalTx } from './record-tx';
import { type ChannelRecordsFrame, PROTOCOL_VERSION } from './sync-protocol';

const TOPIC = 'org-feed.o1';
const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};
const WRITE = 'likePost:w1';

/** The dummy's twin: convergent over `likedByMe`, a column a channel row never carries. */
function like(tx: unknown): void {
  (tx as LocalTx)['posts']?.update('p1', (post) =>
    post['likedByMe'] === true ? {} : { likedByMe: true, likes: Number(post['likes']) + 1 },
  );
}

const frame = (seq: number, likes: number, write?: string): ChannelRecordsFrame => ({
  type: 'records',
  v: PROTOCOL_VERSION,
  channel: TOPIC,
  seq,
  epoch: 'e1',
  adopt: { posts: { p1: { id: 'p1', likes } } },
  ...(write === undefined ? {} : { write }),
});

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A page with one pending like on `posts:p1` (1 → 2) and a catch-up read the test answers. */
async function harness() {
  const timers: { readonly ms: number; readonly fire: () => void; cancelled: boolean }[] = [];
  const store = new RecordStore({
    schedule: (fire, ms) => {
      const timer = { ms, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  let answer: (records: CatchUpRecords) => void = () => undefined;
  const book = new ChannelBook({
    store,
    send: () => undefined,
    connected: () => true,
    catchUp: () =>
      new Promise<CatchUpRecords>((resolve) => {
        answer = resolve;
      }),
    report: () => undefined,
  });
  book.hold(orgFeed, { orgId: 'o1' });
  book.records(frame(1, 1));
  store.push(WRITE, like, 'server-wins');
  const digest = await writeDigest(WRITE);
  if (digest === undefined) return expect.unreachable('this runtime digests no write');
  const painted: number[] = [];
  store.subscribe(() => painted.push(Number(store.peek('posts', 'p1')?.['likes'])));
  // The socket came back behind the node: the channel is re-read, its frames held meanwhile.
  book.gap({ type: 'replay-gap', v: PROTOCOL_VERSION, channel: TOPIC, epoch: 'e1' });
  const read = async (likes: number, current?: () => boolean): Promise<void> => {
    answer({ records: { posts: { p1: { id: 'p1', likes } } }, current });
    await turn();
  };
  /** Another reading of the read: any rows, as the node answered them. */
  const readRows = async (rows: Record<string, Record<string, unknown>>): Promise<void> => {
    answer({ records: { posts: rows as never } });
    await turn();
  };
  const bound = (): void => {
    for (const timer of timers) {
      if (timer.ms === DEFAULT_AWAIT_SERVER_MS && !timer.cancelled) timer.fire();
    }
  };
  return { book, store, digest, painted, read, readRows, bound, timers };
}

describe('a catch-up read that answers before the write it holds is echoed', () => {
  test('never paints above the true count: it lands when the write is answered', async () => {
    const { book, store, digest, painted, read } = await harness();
    // The write committed; the read's snapshot holds it.
    await read(2);
    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);

    // The HTTP answer: a view, no records (the dummy's `likePost`), so the twin waits for a row.
    store.settle(WRITE, new Set());
    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(store.pending()).toEqual([]);

    // The echo, late, changes nothing.
    book.records(frame(2, 2, digest));
    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(painted).not.toContain(3);
  });

  test('or when its echo arrives behind the read: both land in one notification', async () => {
    const { book, store, digest, painted, read } = await harness();
    await read(2);
    book.records(frame(2, 2, digest));

    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(store.pending()).toEqual([]);
    expect(painted).not.toContain(3);
  });

  test('a read OLDER than the write is not landed over the answer that holds it', async () => {
    const { store, painted, read } = await harness();
    // The snapshot predates the commit: 1, without the like.
    await read(1);
    // The answer carries the row with the like, and settles the twin against it.
    store.adopt('posts', { p1: { id: 'p1', likedByMe: true, likes: 2 } });
    store.settle(WRITE, new Set(['posts:p1']));

    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);
    expect(painted).not.toContain(1);
    expect(painted).not.toContain(3);
  });
});

describe('the hold is bounded by the store server wait', () => {
  test('nothing answers: the read lands at the bound, exactly as it did before', async () => {
    const { store, read, bound } = await harness();
    await read(2);
    expect(store.peek('posts', 'p1')?.['likes']).toBe(2);

    bound();
    // As before #778: the read is truth under the twin of a write nobody answered.
    expect(store.synced('posts', 'p1')?.['likes']).toBe(2);
    expect(store.peek('posts', 'p1')?.['likes']).toBe(3);
    expect(store.pending()).toEqual([WRITE]);
  });

  test('a write made after the read answered does not extend the hold', async () => {
    const { store, read } = await harness();
    await read(2);
    store.push('likePost:w2', () => undefined, 'server-wins');
    store.settle(WRITE, new Set());

    expect(store.synced('posts', 'p1')?.['likes']).toBe(2);
  });
});

describe('a principal that leaves while the read is held', () => {
  test('takes the frames held behind it too: nothing of theirs lands in the cleared store', async () => {
    const { book, store, read } = await harness();
    let mine = true;
    await read(2, () => mine);
    // A frame of the old principal's, held behind the read.
    book.records({
      type: 'records',
      v: PROTOCOL_VERSION,
      channel: TOPIC,
      seq: 2,
      epoch: 'e1',
      adopt: { secrets: { s1: { id: 's1', of: 'old-principal' } } },
    });
    mine = false;
    store.clear();

    expect(store.peek('secrets', 's1')).toBeUndefined();
    expect(store.peek('posts', 'p1')).toBeUndefined();
  });
});

describe('a row moved by another reader while the read is held', () => {
  test('keeps the read for every column that reader did not move', async () => {
    const { store, readRows } = await harness();
    store.merge('posts', 'p1', { title: 'old' });
    // Another member retitled the post in the gap; the read holds that, and the like.
    await readRows({ p1: { id: 'p1', likes: 2, title: 'NEW' } });
    // A narrower live query reaches the row meanwhile: its likes, nothing else.
    store.merge('posts', 'p1', { id: 'p1', likes: 2 });
    store.settle(WRITE, new Set());

    expect(store.synced('posts', 'p1')).toEqual({ id: 'p1', likes: 2, title: 'NEW' });
  });

  test('never lands the read over a column that moved', async () => {
    const { store, readRows } = await harness();
    await readRows({ p1: { id: 'p1', likes: 1 } });
    store.adopt('posts', { p1: { id: 'p1', likedByMe: true, likes: 2 } });
    store.settle(WRITE, new Set(['posts:p1']));

    expect(store.synced('posts', 'p1')?.['likes']).toBe(2);
  });
});

describe('a landing that throws', () => {
  test('is reported by the store, and the write that released it still settles', async () => {
    const reported: unknown[] = [];
    const store = new RecordStore({ report: (error) => reported.push(error) });
    store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    store.push(WRITE, like, 'server-wins');
    const landed: string[] = [];
    store.afterWrites(new Set(['posts']), () => {
      throw new UltimateError({ code: 'X_INVARIANT', cause: 'a landing threw', fix: 'none' });
    });
    store.afterWrites(new Set(['posts']), () => landed.push('second'));

    expect(() => store.settle(WRITE, new Set(['posts:p1']))).not.toThrow();
    expect(store.pending()).toEqual([]);
    expect(landed).toEqual(['second']);
    expect(reported).toHaveLength(1);
  });
});
