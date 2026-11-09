// After a slot recreate the stream is another timeline: positions BELOW the old one are new
// changes, and the old position names nothing on the new slot. The replicator kept both — a new
// change at or below it was dropped as `outOfOrder`, and a later run resumed the new slot from it.

import { expect, test } from 'bun:test';
import { memoryAdvisoryLock } from './advisory-lock';
import type { ChangeEvent, ChangeFeed, ChangeFeedStartOptions } from './changefeed';
import { formatLsn } from './changefeed';
import { InProcessTransport } from './fanout';
import { parseResync } from './replication-resync';
import { CHANGE_SUBJECT_ALL, changeFeedReplicator } from './replicator';
import type { Scheduler } from './thundering-herd';

/** A feed the test drives by hand: what each `start()` was handed, and its handlers. */
class HandFeed implements ChangeFeed {
  readonly source = 'hand';
  readonly starts: ChangeFeedStartOptions[] = [];
  resyncOnStart = false;
  async start(options: ChangeFeedStartOptions): Promise<void> {
    this.starts.push(options);
    if (this.resyncOnStart) options.onResync?.('slot recreated');
  }
  async stop(): Promise<void> {}
  abandon(): void {}
  lastLsn(): string | null {
    return null;
  }
  get live(): ChangeFeedStartOptions {
    const current = this.starts.at(-1);
    if (current === undefined) return expect.unreachable('the feed was never started');
    return current;
  }
}

const change = (position: number): ChangeEvent => ({
  table: 'posts',
  op: 'insert',
  before: null,
  after: { id: `p${position}`, orgId: 'o1' },
  lsn: formatLsn(position),
  txid: '1',
  orgId: 'o1',
  at: 0,
  write: null,
});

const turns = async (): Promise<void> => {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
};

test('a recreated slot is a new timeline: no stale position drops its changes or resumes it', async () => {
  const transport = new InProcessTransport();
  const heard: string[] = [];
  await transport.subscribe(CHANGE_SUBJECT_ALL, (payload) => void heard.push(payload));
  let armed: (() => void) | undefined;
  const schedule: Scheduler = (fn) => {
    armed = fn;
    return () => {
      armed = undefined;
    };
  };
  const feed = new HandFeed();
  const replicator = changeFeedReplicator({
    feed,
    transport,
    lock: memoryAdvisoryLock('x:rs:pos'),
    from: formatLsn(0x100),
    schedule,
  });
  expect(await replicator.start()).toBe(true);
  await feed.live.onChange(change(0x900));

  // The stream dies; the next run finds its slot recreated.
  feed.live.onEnd?.('walsender gone');
  feed.resyncOnStart = true;
  armed?.();
  await turns();
  expect(feed.starts).toHaveLength(2);
  expect(feed.starts[1]?.from).toBe(formatLsn(0x900));

  // Below the old position, on the new timeline: a NEW change, published.
  await feed.live.onChange(change(0x800));
  expect(replicator.stats().outOfOrder).toBe(0);
  const changes = heard.filter((payload) => parseResync(payload) === null);
  expect(changes).toHaveLength(2);

  // A run after that resumes from what the NEW slot delivered — never the old server's position.
  feed.resyncOnStart = false;
  feed.live.onEnd?.('walsender gone again');
  armed?.();
  await turns();
  expect(feed.starts[2]?.from).toBe(formatLsn(0x800));
  await replicator.stop();
});

test('a recreated slot with nothing delivered since resumes from no position at all', async () => {
  let armed: (() => void) | undefined;
  const feed = new HandFeed();
  const replicator = changeFeedReplicator({
    feed,
    transport: new InProcessTransport(),
    lock: memoryAdvisoryLock('x:rs:pos2'),
    from: formatLsn(0x100),
    schedule: (fn) => {
      armed = fn;
      return () => undefined;
    },
  });
  feed.resyncOnStart = true;
  expect(await replicator.start()).toBe(true);
  feed.resyncOnStart = false;
  feed.live.onEnd?.('walsender gone');
  armed?.();
  await turns();
  // Not `options.from`: that position is the old slot's, and would filter the new one.
  expect(feed.starts[1]?.from).toBeUndefined();
  await replicator.stop();
});

test('one resync owed is published once, however many paths ask for it at once', async () => {
  const transport = new InProcessTransport();
  const heard: string[] = [];
  await transport.subscribe(CHANGE_SUBJECT_ALL, (payload) => void heard.push(payload));
  const publish = transport.publish.bind(transport);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transport.publish = async (subject, payload) => {
    if (parseResync(payload) !== null) await gate;
    return publish(subject, payload);
  };
  const feed = new HandFeed();
  feed.resyncOnStart = true;
  const replicator = changeFeedReplicator({ feed, transport, lock: memoryAdvisoryLock('x:rs:1x') });
  expect(await replicator.start()).toBe(true);
  // The boot's publish is parked; a change asks for the same resync meanwhile.
  const delivered = feed.live.onChange(change(0x10));
  await turns();
  release();
  await delivered;
  expect(heard.filter((payload) => parseResync(payload) !== null)).toHaveLength(1);
  await replicator.stop();
});
