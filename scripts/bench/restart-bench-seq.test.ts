// The seq accumulator's arithmetic, with no socket in the way: what counts as a hole, and why a
// publisher whose counter restarts per process is a rewind rather than mass loss.

import { describe, expect, test } from 'bun:test';
import {
  beginSeqEpoch,
  newSeqCounters,
  recordSeq,
  type SeqCounters,
  summarizeSeq,
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
      duplicates: 0,
      rewinds: 0,
      malformed: 0,
    });
  });
});
