// The resume chain (envelope v2): a replicator run's first envelope says where it resumed `from`,
// and a sync node that has already seen everything up to there reads the new run as a
// continuation instead of a gap. Mixed fleets during a roll must fall back to "gap", never to
// "no gap" — so those cases come first.

import { describe, expect, test } from 'bun:test';
import { memoryAdvisoryLock } from './advisory-lock';
import type { ChangeEvent, ChangeFeed, ChangeFeedStartOptions } from './changefeed';
import { formatLsn, memoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import { CHANGE_SUBJECT_PREFIX, changeFeedReplicator } from './replicator';
import {
  type ChangeEnvelope,
  encodeEnvelope,
  parseEnvelope,
  SeqGapDetector,
} from './replicator-envelope';

const at = (position: number, producer: string, seq: number, from?: number): ChangeEnvelope => ({
  change: {
    table: 'posts',
    op: 'insert',
    before: null,
    after: { id: `p${position}` },
    lsn: formatLsn(position),
    txid: String(position),
    orgId: null,
    at: 0,
    write: null,
  },
  seq,
  producer,
  ...(from === undefined ? {} : { from: formatLsn(from) }),
});

/** The bytes a run's first envelope travels in, through the one encoder and the one decoder. */
const wire = (envelope: ChangeEnvelope): ChangeEnvelope | null =>
  parseEnvelope(
    encodeEnvelope(
      envelope.change,
      envelope.seq ?? 1,
      envelope.producer ?? 'r',
      undefined,
      envelope.from,
    ),
  );

describe('mixed fleet: every half-upgraded pairing still reads a restart as a gap', () => {
  test('old replicator, new node: a new run with no `from` is a gap (the producer rule)', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(1, 'r1', 1));
    expect(gaps.observe(at(2, 'r2', 1))).toBe(true);
  });

  test('new replicator, old node: `from` is additive — the old fields decode unchanged', () => {
    const decoded = JSON.parse(encodeEnvelope(at(5, 'r2', 1).change, 1, 'r2', undefined, 'f'));
    // What an old node reads off the wire: the change, `seq` and `producer`, as before. It knows
    // no `from`, so its own producer rule answers "gap" for the new run.
    expect(decoded.seq).toBe(1);
    expect(decoded.producer).toBe('r2');
    expect(decoded.table).toBe('posts');
    const oldNode = new SeqGapDetector();
    oldNode.observe(at(4, 'r1', 1));
    expect(oldNode.observe({ ...at(5, 'r2', 1) })).toBe(true);
  });

  test('a `from` under any version but 2 is not trusted: the node falls back to "gap"', () => {
    const payload = JSON.parse(encodeEnvelope(at(5, 'r2', 1).change, 1, 'r2', undefined, 'x'));
    for (const v of [undefined, 1, 3, '2']) {
      const parsed = parseEnvelope(JSON.stringify({ ...payload, v }));
      expect(parsed?.from).toBeUndefined();
    }
    expect(wire(at(5, 'r2', 1, 4))?.from).toBe(formatLsn(4));
  });
});

describe('SeqGapDetector reads the resume chain', () => {
  test('a new run resuming at or below what the node has seen is no gap', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(1, 'r1', 1));
    gaps.observe(at(2, 'r1', 2));
    expect(gaps.observe(at(3, 'r2', 1, 2))).toBe(false);
    // Below is a redelivery the window's lsn guard drops: still nothing missed.
    expect(gaps.observe(at(4, 'r3', 1, 1))).toBe(false);
  });

  test('a new run resuming ABOVE what the node has seen is a gap: the old tail never arrived', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(1, 'r1', 1));
    // r1 published 2 and 3; this node never got them, and r1 has no later seq to show it.
    expect(gaps.observe(at(4, 'r2', 1, 3))).toBe(true);
  });

  test('a record publisher never moves the chain: its lsn orders nothing', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(1, 'r1', 1));
    gaps.observe({ ...at(9, 'w1', 1), source: 'publisher' });
    expect(gaps.observe(at(10, 'r2', 1, 9))).toBe(true);
  });

  test('a redelivery never lowers the chain', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(5, 'r1', 1));
    gaps.observe(at(3, 'r1', 1));
    expect(gaps.observe(at(6, 'r2', 1, 5))).toBe(false);
  });

  test('forget() drops the chain with the producers', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(at(5, 'r1', 1));
    gaps.forget();
    gaps.observe(at(1, 'r2', 1));
    expect(gaps.observe(at(6, 'r3', 1, 5))).toBe(true);
  });
});

/** A replicator over a memory feed, its bus read back by one node's detector. */
const node = async () => {
  const transport = new InProcessTransport();
  const gaps = new SeqGapDetector();
  const seen: ChangeEnvelope[] = [];
  let invalidations = 0;
  await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
    const envelope = parseEnvelope(payload);
    if (envelope === null) return;
    seen.push(envelope);
    if (gaps.observe(envelope)) invalidations += 1;
  });
  const feed = memoryChangeFeed();
  const replicator = changeFeedReplicator({
    feed,
    transport,
    lock: memoryAdvisoryLock(`x:replicator:chain-${crypto.randomUUID()}`),
  });
  return { transport, feed, replicator, seen, invalidations: () => invalidations };
};

describe('a replicator restart, end to end', () => {
  test('stop() then start(): the new run chains on, zero invalidations', async () => {
    const { feed, replicator, seen, invalidations } = await node();
    await replicator.start();
    await feed.push('posts', 'insert', { after: { id: 'p1' } });
    await feed.push('posts', 'insert', { after: { id: 'p2' } });
    await replicator.stop();
    await replicator.start();
    await feed.push('posts', 'insert', { after: { id: 'p3' } });
    await replicator.stop();

    expect(seen.map((one) => one.seq)).toEqual([1, 2, 1]);
    expect(seen[0]?.from).toBeUndefined();
    expect(seen[1]?.from).toBeUndefined();
    expect(seen[2]?.from).toBe(seen[1]?.change.lsn as string);
    expect(invalidations()).toBe(0);
  });

  test('a node that missed the old run’s tail is told: one invalidation', async () => {
    const { transport, feed, replicator, invalidations } = await node();
    await replicator.start();
    await feed.push('posts', 'insert', { after: { id: 'p1' } });
    // The tail is published while this node is not listening — core NATS drops it for this node.
    const real = transport.publish.bind(transport);
    transport.publish = async () => undefined;
    await feed.push('posts', 'insert', { after: { id: 'p2' } });
    transport.publish = real;
    await replicator.stop();
    await replicator.start();
    await feed.push('posts', 'insert', { after: { id: 'p3' } });
    await replicator.stop();
    expect(invalidations()).toBe(1);
  });
});

/** A feed that says its slot was recreated as it starts — the resync `dialReplication` reports. */
const recreatedSlotFeed = (): ChangeFeed & { deliver(change: ChangeEvent): Promise<void> } => {
  let options: ChangeFeedStartOptions | undefined;
  return {
    source: 'test',
    async start(given) {
      options = given;
      given.onResync?.('replication slot "s" was recreated under resume position 0000000000000004');
    },
    async stop() {},
    abandon() {},
    lastLsn: () => null,
    async deliver(change) {
      await options?.onChange(change);
    },
  };
};

describe('what a run claims to resume from', () => {
  test('the configured resume position, on the first envelope only', async () => {
    const transport = new InProcessTransport();
    const seen: (ChangeEnvelope | null)[] = [];
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      seen.push(parseEnvelope(payload));
    });
    const feed = memoryChangeFeed();
    const lock = memoryAdvisoryLock(`x:replicator:from-${crypto.randomUUID()}`);
    const replicator = changeFeedReplicator({ feed, transport, lock, from: formatLsn(0) });
    await replicator.start();
    await feed.push('posts', 'insert', { after: { id: 'p1' } });
    await feed.push('posts', 'insert', { after: { id: 'p2' } });
    await replicator.stop();
    expect(seen.map((one) => one?.from)).toEqual([formatLsn(0), undefined]);
  });

  test('nothing after a resync: a recreated slot is a new timeline, not a continuation', async () => {
    const transport = new InProcessTransport();
    const seen: (ChangeEnvelope | null)[] = [];
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      seen.push(parseEnvelope(payload));
    });
    const feed = recreatedSlotFeed();
    const lock = memoryAdvisoryLock(`x:replicator:resync-${crypto.randomUUID()}`);
    const replicator = changeFeedReplicator({ feed, transport, lock, from: formatLsn(4) });
    await replicator.start();
    await feed.deliver(at(7, 'ignored', 1).change);
    await replicator.stop();
    const changes = seen.filter((one) => one !== null);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.seq).toBe(1);
    expect(changes[0]?.from).toBeUndefined();
  });
});
