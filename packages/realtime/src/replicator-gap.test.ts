// The publish-side sequence and the consume-side gap detector — the two halves of "this node
// missed changes", which core NATS cannot tell anyone on its own.
//
// Failure case first: a skipped sequence must be visible. It was not, and an lsn cannot answer it —
// a WAL position is a byte offset, so every legitimate next change is already an arbitrary jump.

import { describe, expect, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import { formatLsn, InMemoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import {
  CHANGE_SUBJECT_PREFIX,
  createReplicator,
  InMemoryAdvisoryLock,
  parseChange,
  parseEnvelope,
  SeqGapDetector,
} from './replicator';

const envelope = (
  producer: string | null,
  seq: number | null,
): Parameters<SeqGapDetector['observe']>[0] => ({
  change: {
    entity: 'posts',
    op: 'insert',
    before: null,
    after: { id: 'p1' },
    lsn: formatLsn(seq ?? 1),
    txid: '1',
    orgId: null,
    at: 0,
  },
  seq,
  producer,
});

describe('SeqGapDetector', () => {
  test('a skipped sequence is a gap', () => {
    const gaps = new SeqGapDetector();
    expect(gaps.observe(envelope('r1', 1))).toBe(false);
    expect(gaps.observe(envelope('r1', 2))).toBe(false);
    // 3..13 were published while this node's connection was down.
    expect(gaps.observe(envelope('r1', 14))).toBe(true);
    // And the stream continues from there without reporting a second one.
    expect(gaps.observe(envelope('r1', 15))).toBe(false);
  });

  test('the first message of a stream is never a gap', () => {
    const gaps = new SeqGapDetector();
    expect(gaps.observe(envelope('r1', 9_001))).toBe(false);
  });

  /** A replicator that took the lock back publishes from its persisted lsn, at seq 1 again. */
  test('a new producer restarts the count rather than reading as a gap', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(envelope('r1', 1));
    gaps.observe(envelope('r1', 2));
    expect(gaps.observe(envelope('r2', 1))).toBe(false);
    expect(gaps.observe(envelope('r2', 2))).toBe(false);
  });

  test('a redelivery is not a gap, and does not turn the next message into one', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(envelope('r1', 1));
    gaps.observe(envelope('r1', 2));
    expect(gaps.observe(envelope('r1', 2))).toBe(false);
    expect(gaps.observe(envelope('r1', 3))).toBe(false);
  });

  test('a publisher that sequences nothing detects nothing, rather than crying gap', () => {
    const gaps = new SeqGapDetector();
    expect(gaps.observe(envelope(null, null))).toBe(false);
    expect(gaps.observe(envelope(null, null))).toBe(false);
  });
});

describe('the replicator sequences what it publishes', () => {
  test('every published change carries a producer and a monotonic seq', async () => {
    const transport = new InProcessTransport();
    const published: string[] = [];
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      published.push(payload);
    });
    const feed = new InMemoryChangeFeed();
    const replicator = createReplicator({
      feed,
      transport,
      lock: new InMemoryAdvisoryLock('x:replicator:test-seq'),
    });
    expect(await replicator.start()).toBe(true);

    await feed.push('posts', 'insert', { after: { id: 'p1' }, orgId: 'o1' });
    await feed.push('posts', 'insert', { after: { id: 'p2' }, orgId: 'o1' });

    const envelopes = published.map((payload) => parseEnvelope(payload));
    expect(envelopes.map((one) => one?.seq)).toEqual([1, 2]);
    expect(envelopes[0]?.producer).toBe(envelopes[1]?.producer as string);
    expect(envelopes[0]?.producer).not.toBeNull();
    // The narrow reader still answers on the same payload: the envelope is additive.
    const change = parseChange(published[0] ?? '') as ChangeEvent;
    expect(change.entity).toBe('posts');
    expect(change.after).toEqual({ id: 'p1' });

    await replicator.stop();
  });
});
