// The fan-out bench's arithmetic: a probe read off the frame the node REALLY sends (the shipped
// encoder, so a wire change that hides the probe fails here rather than reporting zero deliveries),
// nearest-rank percentiles, and the split of subscribers across nodes.

import { describe, expect, test } from 'bun:test';
import { encode, PROTOCOL_VERSION } from '../../packages/realtime/src/sync-protocol';
import { latencyOf, splitAcross, summarise } from './fanout-shape';

describe('fan-out bench shape', () => {
  test('a probe is read off an encoded events frame', () => {
    const frame = encode({
      type: 'events',
      v: PROTOCOL_VERSION,
      channel: 'benchfanout:org',
      event: { probeIndex: 7, probeSentAt: 1_000.5 },
    });
    expect(latencyOf(frame, 1_004)).toEqual({ index: 7, ms: 3.5 });
  });

  test('a frame without a probe is not counted', () => {
    expect(latencyOf('{"type":"hello"}', 1)).toBeUndefined();
  });

  test('percentiles are nearest-rank, and empty is zeros', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(summarise(samples)).toEqual({ deliveries: 100, p50Ms: 50, p99Ms: 99, maxMs: 100 });
    expect(summarise([])).toEqual({ deliveries: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 });
  });

  test('subscribers split across nodes, whole sockets, summing to the total', () => {
    expect(splitAcross(10_000, 3)).toEqual([3_334, 3_333, 3_333]);
  });
});
