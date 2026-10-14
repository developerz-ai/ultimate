// What becomes of a catch-up read's own answer: a read superseded by a gap or a newer epoch still
// lands its rows (a re-read that then fails must not leave the older rows for the whole retry
// curve), and a read that crossed a principal change lands nothing — the transport's own fence.

import { afterEach, describe, expect, test } from 'bun:test';
import { rescope } from '@ultimat3/core/page';
import type { CatchUpRecords } from './channel-catch-up';
import { catchUpRead } from './channel-catch-up';
import { ChannelBook } from './client-channels';
import { resetPage } from './hooks-fixture';
import { RecordStore } from './record-store';
import { PROTOCOL_VERSION } from './sync-protocol';

const TOPIC = 'org-feed.o1';
const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};
const gap = { type: 'replay-gap', v: PROTOCOL_VERSION, channel: TOPIC, epoch: 'e1' } as const;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetPage();
});

/** Settles the read the book is waiting on, in the order it asked. */
function reads() {
  const waiting: { resolve(value: CatchUpRecords | undefined): void; reject(e: unknown): void }[] =
    [];
  const catchUp = () =>
    new Promise<CatchUpRecords | undefined>((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  return { waiting, catchUp };
}

const turns = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
};

describe('a superseded catch-up read', () => {
  test('lands its rows before the re-read, so a re-read that fails leaves them, not older ones', async () => {
    const store = new RecordStore();
    store.adopt('posts', { p1: { id: 'p1', likes: 1 } });
    const { waiting, catchUp } = reads();
    const book = new ChannelBook({
      store,
      send: () => undefined,
      connected: () => true,
      catchUp,
      report: () => undefined,
    });
    book.hold(orgFeed, { orgId: 'o1' });
    book.gap(gap);
    // A second gap while the first read is out: that read is answered, then re-read.
    book.gap(gap);
    waiting[0]?.resolve({ records: { posts: { p1: { id: 'p1', likes: 5 } } } });
    await turns();
    expect(waiting).toHaveLength(2);
    waiting[1]?.reject(new TypeError('Failed to fetch'));
    await turns();
    expect(store.peek('posts', 'p1')?.['likes']).toBe(5);
  });
});

describe('a catch-up read across a principal change', () => {
  test('answered, then a rescope: the book adopts none of the previous principal’s rows', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [], records: { posts: { p1: { id: 'p1' } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ultimate-records': '1' },
      })) as unknown as typeof fetch;
    const answered = await catchUpRead('orgFeedCatchUp', { orgId: 'o1' });
    expect(answered?.current?.()).toBe(true);
    rescope('user:2');
    expect(answered?.current?.()).toBe(false);

    const store = new RecordStore();
    const { waiting, catchUp } = reads();
    const book = new ChannelBook({
      store,
      send: () => undefined,
      connected: () => true,
      catchUp,
      report: () => undefined,
    });
    book.hold(orgFeed, { orgId: 'o1' });
    book.gap(gap);
    waiting[0]?.resolve(answered);
    await turns();
    expect(store.peek('posts', 'p1')).toBeUndefined();
  });
});
