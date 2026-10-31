// What a channel holds per membership is bounded by the node's ring. Frames held behind a catch-up
// read that is slow or failing, and applied seqs above a hole no `replay-gap` announced, both grew
// for as long as the condition lasted — a failing read for an hour held every frame of the hour.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_CHANNEL_RING } from './channel-ring';
import { CHANNEL_HELD_FRAMES, ChannelBook } from './client-channels';
import { RecordStore } from './record-store';
import { type ChannelRecordsFrame, PROTOCOL_VERSION, type ReplayGapFrame } from './sync-protocol';

const feed = {
  name: 'feed',
  catchUp: 'feedCatchUp',
  topic: () => 'feed.all',
};

const records = (seq: number): ChannelRecordsFrame => ({
  type: 'records',
  v: PROTOCOL_VERSION,
  channel: 'feed.all',
  seq,
  epoch: 'e1',
  adopt: { posts: { [`p${seq}`]: { id: `p${seq}` } } },
});

const gap: ReplayGapFrame = {
  type: 'replay-gap',
  v: PROTOCOL_VERSION,
  channel: 'feed.all',
  epoch: 'e1',
};

/** A catch-up read the test answers by hand: nothing really waits. */
function harness() {
  const answers: ((value: undefined) => void)[] = [];
  const store = new RecordStore();
  const book = new ChannelBook({
    store,
    send: () => undefined,
    connected: () => true,
    catchUp: () =>
      new Promise<undefined>((resolve) => {
        answers.push(resolve);
      }),
    report: () => undefined,
  });
  const membership = book.hold(feed, {});
  return { book, store, membership, answers };
}

const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe('the frames a channel holds', () => {
  test('the bound is the node’s ring: past it a replay could not answer either', () => {
    expect(CHANNEL_HELD_FRAMES).toBe(DEFAULT_CHANNEL_RING);
  });

  test('past the ring, frames held behind a read are dropped and one more read follows', async () => {
    const { book, store, answers } = harness();
    book.gap(gap);
    expect(answers).toHaveLength(1);
    for (let seq = 1; seq <= CHANNEL_HELD_FRAMES + 1; seq += 1) book.records(records(seq));

    answers[0]?.(undefined);
    for (let tick = 0; tick < 5; tick += 1) await settle();
    // Nothing the dropped frames carried landed: the re-read answers for them.
    expect(store.size).toBe(0);
    expect(answers).toHaveLength(2);
  });

  test('up to the ring, every held frame lands with the read, and no second read', async () => {
    const { book, store, answers } = harness();
    book.gap(gap);
    for (let seq = 1; seq <= CHANNEL_HELD_FRAMES; seq += 1) book.records(records(seq));
    answers[0]?.(undefined);
    for (let tick = 0; tick < 5; tick += 1) await settle();
    expect(store.size).toBe(CHANNEL_HELD_FRAMES);
    expect(answers).toHaveLength(1);
  });

  test('a hole the ring has moved past forces a catch-up instead of growing for the session', () => {
    const { book, membership, answers } = harness();
    book.records(records(1));
    // Seq 2 is lost and no `replay-gap` says so: every later seq sits above the hole.
    for (let seq = 3; seq < 3 + CHANNEL_HELD_FRAMES; seq += 1) book.records(records(seq));
    expect(answers).toHaveLength(0);
    expect(membership.state()).toBe('live');

    book.records(records(3 + CHANNEL_HELD_FRAMES));
    expect(answers).toHaveLength(1);
    expect(membership.state()).toBe('catching-up');
  });
});
