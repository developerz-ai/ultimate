// The channel book's STATE: every answer the node can give a (re)subscribe ends `joining`. An
// up-to-date resume is answered with the frame at the cursor; an events channel with its roster.

import { describe, expect, test } from 'bun:test';
import { ChannelBook, type ChannelMembership } from './client-channels';
import { RecordStore } from './record-store';
import {
  type ChannelEventsFrame,
  type ChannelRecordsFrame,
  PROTOCOL_VERSION,
  type SubscribeFrame,
} from './sync-protocol';

const orgFeed = {
  name: 'org-feed',
  catchUp: 'orgFeedCatchUp',
  topic: (params: Readonly<Record<'orgId', string>>) => `org-feed.${params.orgId}`,
};
const TOPIC = 'org-feed.o1';

function harness(catchUp: () => Promise<unknown> = async () => undefined) {
  const sent: SubscribeFrame[] = [];
  const store = new RecordStore();
  const book = new ChannelBook({
    store,
    send: (frame) => sent.push(frame),
    connected: () => true,
    catchUp,
    report: () => undefined,
  });
  const membership: ChannelMembership = book.hold(orgFeed, { orgId: 'o1' });
  return { book, store, sent, membership };
}

const records = (seq: number, rows = true): ChannelRecordsFrame => ({
  type: 'records',
  v: PROTOCOL_VERSION,
  channel: TOPIC,
  seq,
  epoch: 'e1',
  ...(rows ? { adopt: { posts: { p1: { id: 'p1', likes: seq } } } } : {}),
});

const event = (body: Record<string, string>) =>
  ({ type: 'events', v: PROTOCOL_VERSION, channel: TOPIC, event: body }) as const;

describe('a resubscribe whose cursor is already current', () => {
  test("goes live on the node's answer — the frame at the cursor — and changes nothing else", () => {
    const { book, store, sent, membership } = harness();
    book.records(records(1));
    book.records(records(2));
    expect(membership.state()).toBe('live');

    book.offline();
    book.resubscribe();
    expect(membership.state()).toBe('joining');
    expect(sent.at(-1)?.target).toMatchObject({ since: { epoch: 'e1', seq: 2 } });

    book.records(records(2, false));
    expect(membership.state()).toBe('live');
    expect(book.since(TOPIC)).toEqual({ epoch: 'e1', seq: 2 });
    expect(store.peek('posts', 'p1')).toEqual({ id: 'p1', likes: 2 });
  });

  test('tells its listeners once', () => {
    const { book, membership } = harness();
    book.records(records(1));
    book.offline();
    book.resubscribe();
    let told = 0;
    membership.onChange(() => {
      told += 1;
    });
    book.records(records(1, false));
    book.records(records(1, false));
    expect(told).toBe(1);
  });
});

describe('an events frame', () => {
  test('makes a JOINING channel live: the node only delivers one to a seated member', () => {
    const { book, membership } = harness();
    const seen: unknown[] = [];
    book.hold(orgFeed, { orgId: 'o1' }, { onEvent: (body) => seen.push(body) });
    expect(membership.state()).toBe('joining');
    book.event(event({ typing: 'alice' }));
    expect(membership.state()).toBe('live');
    expect(seen).toEqual([{ typing: 'alice' }]);
  });

  // What a node with NO presence registry answers every add and every beat on an events-only
  // channel with: an empty roster. It is the only answer such a channel ever gets.
  test('the empty roster of a node without presence is enough: joining → live, once', () => {
    const { book, membership } = harness();
    const rosters: unknown[] = [];
    book.hold(orgFeed, { orgId: 'o1' }, { onPresence: (roster) => rosters.push(roster) });
    let told = 0;
    membership.onChange(() => {
      told += 1;
    });
    const empty: ChannelEventsFrame = {
      type: 'events',
      v: PROTOCOL_VERSION,
      channel: TOPIC,
      event: { presence: 'sync', members: [], total: 0 },
    };
    book.event(empty);
    book.event(empty); // the next beat's answer
    expect(membership.state()).toBe('live');
    expect(told).toBe(1);
    expect(rosters).toHaveLength(2);
  });

  test('never ends a catch-up read early', async () => {
    let land: () => void = () => undefined;
    const { book, membership } = harness(
      () =>
        new Promise<void>((resolve) => {
          land = resolve;
        }),
    );
    book.gap({ type: 'replay-gap', v: PROTOCOL_VERSION, channel: TOPIC, epoch: 'e1' });
    expect(membership.state()).toBe('catching-up');
    book.event(event({ typing: 'alice' }));
    expect(membership.state()).toBe('catching-up');
    land();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(membership.state()).toBe('live');
  });

  test('never revives a refused channel, nor one that is offline', () => {
    const refused = harness();
    refused.book.refused(`channel:${TOPIC}`, { code: 'X_TOPIC_FORBIDDEN' });
    refused.book.event(event({ typing: 'alice' }));
    expect(refused.membership.state()).toBe('failed');

    const offline = harness();
    offline.book.offline();
    offline.book.event(event({ typing: 'alice' }));
    expect(offline.membership.state()).toBe('offline');
  });
});
