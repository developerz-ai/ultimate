// The publish-side sequence and the consume-side gap detector — the two halves of "this node
// missed changes", which core NATS cannot tell anyone on its own.
//
// Failure case first: a skipped sequence must be visible. It was not, and an lsn cannot answer it —
// a WAL position is a byte offset, so every legitimate next change is already an arbitrary jump.

import { describe, expect, test } from 'bun:test';
import { memoryAdvisoryLock } from './advisory-lock';
import type { ChangeEvent } from './changefeed';
import { formatLsn, memoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import { CHANGE_SUBJECT_PREFIX, changeFeedReplicator } from './replicator';
import { encodeEnvelope, parseChange, parseEnvelope, SeqGapDetector } from './replicator-envelope';

const envelope = (
  producer: string | null,
  seq: number | null,
): Parameters<SeqGapDetector['observe']>[0] => ({
  change: {
    table: 'posts',
    op: 'insert',
    before: null,
    after: { id: 'p1' },
    lsn: formatLsn(seq ?? 1),
    txid: '1',
    orgId: null,
    at: 0,
    write: null,
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

  // The run before it DIED, and the tail of a dead stream has no later seq to be missed against:
  // whatever it published last may never have reached this node, and nothing else would say so.
  test('a new producer after a known one is a gap, once', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(envelope('r1', 1));
    gaps.observe(envelope('r1', 2));
    expect(gaps.observe(envelope('r2', 1))).toBe(true);
    expect(gaps.observe(envelope('r2', 2))).toBe(false);
    // A straggler from the old run is neither a new producer nor a skipped sequence.
    expect(gaps.observe(envelope('r1', 3))).toBe(false);
  });

  // Publishers run one per app process, side by side: a new one is no successor, and neither is a
  // replicator run that follows only publishers. A hole inside one publisher's sequence still is.
  test('a record publisher never succeeds another producer, and a hole in its own sequence is a gap', () => {
    const gaps = new SeqGapDetector();
    const published = (producer: string, seq: number) => ({
      ...envelope(producer, seq),
      source: 'publisher' as const,
    });
    expect(gaps.observe(published('w1', 1))).toBe(false);
    expect(gaps.observe(published('w2', 1))).toBe(false);
    expect(gaps.observe(envelope('r1', 1))).toBe(false);
    expect(gaps.observe(published('w3', 1))).toBe(false);
    expect(gaps.observe(published('w1', 3))).toBe(true);
    // The replicator rule stands beside them: its next run is still a successor.
    expect(gaps.observe(envelope('r2', 1))).toBe(true);
  });

  test('a source on the bus is read back, and only the one spelling the publisher writes', () => {
    const wire = (source: unknown) =>
      JSON.stringify({ ...envelope('w1', 1).change, seq: 1, producer: 'w1', source });
    expect(parseEnvelope(wire('publisher'))?.source).toBe('publisher');
    expect(parseEnvelope(wire('PUBLISHER'))?.source).toBeUndefined();
    expect(parseEnvelope(wire(undefined))?.source).toBeUndefined();
  });

  // The ONE writer of the bus envelope, for both producers: what it writes is what `parseEnvelope`
  // reads back, flat, with `source` only where a publisher sent it.
  test("encodeEnvelope is parseEnvelope's inverse, for the replicator and a publisher alike", () => {
    const { change } = envelope('r1', 4);
    const replicated = encodeEnvelope(change, 4, 'r1');
    expect(JSON.parse(replicated)).not.toHaveProperty('source');
    expect(parseEnvelope(replicated)).toEqual({ change, seq: 4, producer: 'r1' });
    // A consumer that only knows the change reads the same payload unchanged.
    expect(parseChange(replicated)).toEqual(change);
    expect(parseEnvelope(encodeEnvelope(change, 1, 'w1', 'publisher'))).toEqual({
      change,
      seq: 1,
      producer: 'w1',
      source: 'publisher',
    });
  });

  test('forget() makes the next producer a first one again', () => {
    const gaps = new SeqGapDetector();
    gaps.observe(envelope('r1', 1));
    gaps.forget();
    expect(gaps.observe(envelope('r2', 1))).toBe(false);
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
    const feed = memoryChangeFeed();
    const replicator = changeFeedReplicator({
      feed,
      transport,
      lock: memoryAdvisoryLock('x:replicator:test-seq'),
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
    expect(change.table).toBe('posts');
    expect(change.after).toEqual({ id: 'p1' });

    await replicator.stop();
  });
});

describe('the write a change belongs to crosses the bus', () => {
  const payload = (write: unknown): string =>
    JSON.stringify({ ...envelope('r1', 1).change, write, seq: 1, producer: 'r1' });

  test('a digest survives the decode; anything else is dropped rather than refused', () => {
    const digest = 'a'.repeat(32);
    expect(parseChange(payload(digest))?.write).toBe(digest);
    // Dropped to `null`, the one spelling of "no keyed write": `ChangeEvent.write` is required.
    for (const malformed of ['likePost:raw-key', 7, null, undefined]) {
      const change = parseChange(payload(malformed));
      expect(change?.table).toBe('posts');
      expect(change?.write).toBeNull();
    }
  });
});
