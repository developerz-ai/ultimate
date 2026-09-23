// `useChannel` and the client channel cursor (plan 101, slices 09–10): one membership per topic per
// page; `records` land in the store and reach holders that never joined the channel; `events`
// never touch it; the cursor drops duplicates, lets a replay fill a hole, resumes from the highest
// contiguous seq, and a `replay-gap` or a new epoch re-reads the channel — with frames that arrive
// meanwhile held and applied after the read.

import { afterEach, describe, expect, test } from 'bun:test';
import { presenceEvent } from './channel-presence';
import { type FakeSocket, pageHarness, resetPage } from './hooks-fixture';
import type { JsonObject } from './json';
import { type ChannelRecordsFrame, PROTOCOL_VERSION, type SubscribeFrame } from './sync-protocol';
import { useChannel, usePresence } from './use-channel';
import { useRecord } from './use-record';

afterEach(() => {
  resetPage();
});

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};

function channelFrames(socket: FakeSocket): SubscribeFrame[] {
  return socket
    .frames()
    .filter(
      (frame): frame is SubscribeFrame =>
        frame.type === 'subscribe' && frame.target.kind === 'channel',
    );
}

function records(seq: number, likes: number, epoch = 'e1'): ChannelRecordsFrame {
  return {
    type: 'records',
    v: PROTOCOL_VERSION,
    channel: 'org-feed.o1',
    seq,
    epoch,
    adopt: { posts: { p1: { id: 'p1', likes } } },
  };
}

describe('useChannel — membership', () => {
  test('two holders on one topic are ONE subscribe; the last release is ONE drop', () => {
    const { socket } = pageHarness();
    socket.open();
    const a = useChannel(orgFeed, { orgId: 'o1' });
    const b = useChannel(orgFeed, { orgId: 'o1' });
    expect(channelFrames(socket).map((frame) => frame.op)).toEqual(['add']);
    const target = channelFrames(socket)[0]?.target;
    expect(target).toEqual({ kind: 'channel', channel: 'org-feed', params: { orgId: 'o1' } });

    a.release();
    expect(channelFrames(socket).map((frame) => frame.op)).toEqual(['add']);
    b.release();
    expect(channelFrames(socket).map((frame) => frame.op)).toEqual(['add', 'drop']);
  });

  test('a records frame reaches a useRecord holder that never joined the channel', () => {
    const { socket } = pageHarness();
    socket.open();
    useChannel(orgFeed, { orgId: 'o1' });
    const post = useRecord('posts', 'p1');
    socket.deliver(records(1, 3));
    expect(post()).toEqual({ status: 'ready', data: { id: 'p1', likes: 3 } });
  });

  test('an events frame reaches the handler and never the store', () => {
    const { socket, page } = pageHarness();
    socket.open();
    const seen: JsonObject[] = [];
    useChannel(orgFeed, { orgId: 'o1' }, { onEvent: (event) => seen.push(event) });
    socket.deliver({
      type: 'events',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      event: { id: 'p1', typing: 'alice' },
    });
    expect(seen).toEqual([{ id: 'p1', typing: 'alice' }]);
    expect(page.store.peek('posts', 'p1')).toBeUndefined();
  });

  test('a refusal fails that channel only; another channel on the socket keeps flowing', () => {
    const { socket } = pageHarness();
    socket.open();
    const denied = useChannel(orgFeed, { orgId: 'o1' });
    const other = useChannel(orgFeed, { orgId: 'o2' });
    socket.deliver({
      type: 'ack',
      v: PROTOCOL_VERSION,
      ref: channelFrames(socket)[0]?.sid ?? '',
      lsn: null,
      error: { code: 'X_TOPIC_FORBIDDEN', cause: 'no', fix: 'x policy list --json' },
    });
    socket.deliver({ ...records(1, 1), channel: 'org-feed.o2' });
    expect(denied()).toBe('failed');
    expect(other()).toBe('live');
  });

  test('on a server render it opens nothing', () => {
    resetPage();
    expect(useChannel(orgFeed, { orgId: 'o1' })()).toBe('joining');
  });

  test('usePresence on a server render is an empty roster and opens nothing', () => {
    resetPage();
    const roster = usePresence(orgFeed, { orgId: 'o1' });
    expect(roster()).toEqual([]);
    roster.release();
  });
});

describe('the channel cursor', () => {
  test('a duplicate is dropped; a replay that fills a hole is applied; since = highest contiguous', () => {
    const { socket, page, client } = pageHarness();
    socket.open();
    useChannel(orgFeed, { orgId: 'o1' });
    socket.deliver(records(1, 1));
    socket.deliver(records(3, 3)); // a hole at 2 — never a gap on its own
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(3);
    socket.deliver(records(1, 99)); // a duplicate
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(3);

    // A reconnect resumes from 1, the highest seq with no hole below it.
    socket.close(1006);
    client.connect();
    socket.open();
    expect(channelFrames(socket).at(-1)?.target).toEqual({
      kind: 'channel',
      channel: 'org-feed',
      params: { orgId: 'o1' },
      since: { epoch: 'e1', seq: 1 },
    });

    socket.deliver(records(2, 2)); // the replay fills the hole: new, applied
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
    socket.deliver(records(3, 77)); // now a duplicate
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
  });

  test('replay-gap re-reads the channel; frames during the read are applied after it', async () => {
    const reads: [string, Readonly<Record<string, string>>][] = [];
    let finish = (): void => undefined;
    const { socket, page } = pageHarness({
      catchUp: (query, params) => {
        reads.push([query, params]);
        return new Promise((resolve) => {
          finish = () => {
            // What the read's envelope adopts: the channel's rows as the server holds them now.
            page.store.adopt('posts', { p1: { id: 'p1', likes: 50 } });
            resolve(undefined);
          };
        });
      },
    });
    socket.open();
    const state = useChannel(orgFeed, { orgId: 'o1' });
    socket.deliver(records(1, 1));
    socket.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      epoch: 'e1',
    });
    expect(reads).toEqual([['orgFeedCatchUp', { orgId: 'o1' }]]);
    expect(state()).toBe('catching-up');

    socket.deliver(records(7, 60)); // arrives mid-read: held, not applied yet
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(1);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    // The read landed (50), THEN the held frame over it (60): the store equals the server.
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(60);
    expect(state()).toBe('live');
  });

  test('a new epoch is a catch-up too: its seqs mean nothing against the old ones', async () => {
    const reads: string[] = [];
    const { socket, page } = pageHarness({
      catchUp: async (query) => {
        reads.push(query);
      },
    });
    socket.open();
    useChannel(orgFeed, { orgId: 'o1' });
    socket.deliver(records(40, 1, 'e1'));
    socket.deliver(records(1, 2, 'e2'));
    expect(reads).toEqual(['orgFeedCatchUp']);
    await Promise.resolve();
    await Promise.resolve();
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(2);
  });
});

describe('a catch-up read that fails', () => {
  test('is reported, and the frames held behind it still land — the channel goes live again', async () => {
    const refused = new TypeError('network down');
    const { socket, page, errors } = pageHarness({ catchUp: () => Promise.reject(refused) });
    socket.open();
    const state = useChannel(orgFeed, { orgId: 'o1' });
    socket.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: 'org-feed.o1',
      epoch: 'e1',
    });
    socket.deliver(records(1, 9));
    expect(page.store.peek('posts', 'p1')).toBeUndefined(); // held behind the read
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([refused]);
    expect(page.store.peek('posts', 'p1')?.['likes']).toBe(9);
    expect(state()).toBe('live');
  });
});

describe('usePresence', () => {
  const member = (id: string) => ({ id, actorId: id, meta: {}, updatedAt: 1 });

  test('a sync replaces the roster, join upserts, leave removes — and an app event is not one', () => {
    const { socket } = pageHarness();
    socket.open();
    const seen: JsonObject[] = [];
    useChannel(orgFeed, { orgId: 'o1' }, { onEvent: (event) => seen.push(event) });
    const room = usePresence(orgFeed, { orgId: 'o1' });
    const send = (event: JsonObject): void =>
      socket.deliver({ type: 'events', v: PROTOCOL_VERSION, channel: 'org-feed.o1', event });

    send(presenceEvent('sync', [member('a'), member('b')], 2));
    expect(room().map((m) => m.id)).toEqual(['a', 'b']);
    send(presenceEvent('join', [member('c')]));
    send(presenceEvent('leave', [member('a')]));
    expect(room().map((m) => m.id)).toEqual(['b', 'c']);
    send({ typing: 'b' });
    expect(seen).toEqual([{ typing: 'b' }]);
    // Presence and the channel are one membership on the page: one subscribe frame.
    expect(channelFrames(socket).map((frame) => frame.op)).toEqual(['add']);
  });
});
