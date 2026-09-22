// The seq accumulator's arithmetic, with no socket in the way: what counts as a hole, and why a
// publisher whose counter restarts per process is a rewind rather than mass loss.

import { describe, expect, test } from 'bun:test';
import {
  beginSeqEpoch,
  newSeqCounters,
  recordReplayGap,
  recordSeq,
  type SeqCounters,
  summarizeSeq,
  unrepairedFindings,
} from './restart-bench-seq';

/** Feeds a whole stream and returns what each value parsed to, so no call is a bare statement. */
const feed = (counters: SeqCounters, ...values: readonly unknown[]): readonly (number | null)[] =>
  values.map((value) => recordSeq(counters, value));

describe('unit · restart-bench seq accounting', () => {
  test('a dense stream is no gap, no duplicate, no rewind', () => {
    const counters = newSeqCounters();
    const parsed = feed(counters, 1, 2, 3, 4, 5);
    expect(parsed).toEqual([1, 2, 3, 4, 5]);
    expect(counters.received).toBe(5);
    expect(counters.missing).toBe(0);
    expect(counters.gapEvents).toBe(0);
    expect(counters.duplicates).toBe(0);
    expect(counters.rewinds).toBe(0);
    expect(counters.epochs).toBe(1);
  });

  test('a stream that starts late is not a gap — the first value anchors the epoch', () => {
    const counters = newSeqCounters();
    feed(counters, 900, 901, 902);
    expect(counters.missing).toBe(0);
    expect(counters.received).toBe(3);
  });

  test('one hole counts one missing frame and one gap event', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 2, 4, 5);
    expect(counters.missing).toBe(1);
    expect(counters.gapEvents).toBe(1);
    expect(counters.received).toBe(4);
  });

  test('a wide hole counts every frame it swallowed, as one event', () => {
    const counters = newSeqCounters();
    feed(counters, 10, 41);
    expect(counters.missing).toBe(30);
    expect(counters.gapEvents).toBe(1);
  });

  test('two holes are two events', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 3, 4, 9);
    expect(counters.missing).toBe(1 + 4);
    expect(counters.gapEvents).toBe(2);
  });

  test('a repeated value is a duplicate, never a gap, and does not move the anchor', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 2, 2, 3);
    expect(counters.duplicates).toBe(1);
    expect(counters.missing).toBe(0);
    expect(counters.gapEvents).toBe(0);
    expect(counters.received).toBe(4);
  });

  // The discriminator the whole metric turns on: a publisher whose counter restarted is a value
  // that goes BACKWARDS, and the next contiguous value after it must not read as a 900-wide hole.
  test('a backwards value is a rewind, re-anchors, and is never counted as missing', () => {
    const counters = newSeqCounters();
    feed(counters, 900, 901, 1, 2, 3);
    expect(counters.rewinds).toBe(1);
    expect(counters.missing).toBe(0);
    expect(counters.gapEvents).toBe(0);
    expect(counters.received).toBe(5);
  });

  // The same restart seen the way the bench actually sees it: the socket dies, so the epoch ends.
  test('a new epoch re-anchors, so a restart between two connections is not a gap', () => {
    const counters = newSeqCounters();
    feed(counters, 5, 6, 7);
    beginSeqEpoch(counters);
    feed(counters, 1, 2);
    expect(counters.missing).toBe(0);
    expect(counters.gapEvents).toBe(0);
    expect(counters.rewinds).toBe(0);
    expect(counters.epochs).toBe(2);
    expect(counters.received).toBe(5);
  });

  test('a hole inside the SECOND epoch is still counted', () => {
    const counters = newSeqCounters();
    feed(counters, 5, 6);
    beginSeqEpoch(counters);
    feed(counters, 1, 3);
    expect(counters.missing).toBe(1);
    expect(counters.gapEvents).toBe(1);
  });

  test('a non-integer seq is counted as malformed and never poisons the next comparison', () => {
    const counters = newSeqCounters();
    const parsed = feed(counters, 1, 'two', null, 3.5, 2, 3);
    expect(parsed).toEqual([1, null, null, null, 2, 3]);
    expect(counters.malformed).toBe(3);
    expect(counters.received).toBe(3);
    expect(counters.missing).toBe(0);
    expect(counters.gapEvents).toBe(0);
  });

  test('summarizeSeq totals the swarm and names how many clients lost anything', () => {
    const clean = newSeqCounters();
    feed(clean, 1, 2, 3);
    const holed = newSeqCounters();
    feed(holed, 1, 4);
    const silent = newSeqCounters();
    const summary = summarizeSeq([clean, holed, silent]);
    expect(summary).toEqual({
      observers: 2,
      clientsWithGaps: 1,
      epochs: 2,
      received: 5,
      missing: 2,
      gapEvents: 1,
      replayGaps: 0,
      repaired: 0,
      unrepaired: 2,
      clientsUnrepaired: 1,
      duplicates: 0,
      rewinds: 0,
      malformed: 0,
    });
  });

  test('a summary over no clients is zeroes, not NaN', () => {
    expect(summarizeSeq([])).toEqual({
      observers: 0,
      clientsWithGaps: 0,
      epochs: 0,
      received: 0,
      missing: 0,
      gapEvents: 0,
      replayGaps: 0,
      repaired: 0,
      unrepaired: 0,
      clientsUnrepaired: 0,
      duplicates: 0,
      rewinds: 0,
      malformed: 0,
    });
  });
});

describe('unit · restart-bench repair accounting', () => {
  test('a hole followed by replay-gap is repaired, not lost', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 2, 5);
    expect(counters.pending).toBe(2);
    recordReplayGap(counters);
    expect(counters).toMatchObject({ missing: 2, repaired: 2, pending: 0, replayGaps: 1 });
    expect(unrepairedFindings(summarizeSeq([counters]))).toEqual([]);
  });

  test('a hole with no replay-gap after it is the run failing, and says how much', () => {
    const repaired = newSeqCounters();
    feed(repaired, 1, 3);
    recordReplayGap(repaired);
    const lost = newSeqCounters();
    feed(lost, 1, 2, 4, 7);
    const summary = summarizeSeq([repaired, lost]);
    expect(summary).toMatchObject({ missing: 4, repaired: 1, unrepaired: 3, clientsUnrepaired: 1 });
    expect(unrepairedFindings(summary)).toEqual([
      expect.stringContaining('3 channel frame(s) lost on 1 client(s)'),
    ]);
  });

  test('the replay-gap the node sends BEFORE the next frame covers the hole that frame reveals', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 2);
    recordReplayGap(counters); // seq 3 was dropped; the node answers before sending 4
    feed(counters, 4, 5, 7); // 3 is covered by the re-read; 6 is not — nothing answered it
    expect(counters).toMatchObject({ missing: 2, repaired: 1, pending: 1 });
  });

  test('a replay-gap repairs a hole left on a connection that has since closed', () => {
    const counters = newSeqCounters();
    feed(counters, 1, 3);
    beginSeqEpoch(counters);
    feed(counters, 40, 41);
    recordReplayGap(counters);
    expect(summarizeSeq([counters]).unrepaired).toBe(0);
  });
});
