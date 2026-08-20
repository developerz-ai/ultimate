// The socket half of the pair, on its own. `PipeWs` is what the node writes through, so what it
// does when the wire is cut — and what it reports about buffering — decides what a test can observe.

import { describe, expect, test } from 'bun:test';
import { PipeWs } from './live-node';

const data = { socketId: 's1', clientBuildId: 'test-build' };

describe('PipeWs', () => {
  test('a frame is recorded and delivered', () => {
    const received: string[] = [];
    const ws = new PipeWs(data, (raw) => received.push(raw));
    expect(ws.send('one')).toBe(3);
    expect(ws.sent).toEqual(['one']);
    expect(received).toEqual(['one']);
    expect(ws.closed).toBe(false);
  });

  /**
   * A dropped connection is a socket that still exists and delivers nothing, which is exactly what
   * a client observes: the frames the node BELIEVES it sent are still counted, and none arrive. A
   * `cut` that also stopped recording would hide the node's own view of the loss, which is the half
   * `channel_frames_dropped_total` exists to count.
   */
  test('cut stops delivery and keeps the node’s own record', () => {
    const received: string[] = [];
    const ws = new PipeWs(data, (raw) => received.push(raw));
    ws.send('before');
    ws.cut();
    ws.send('after');
    expect(ws.closed).toBe(true);
    expect(ws.sent).toEqual(['before', 'after']);
    expect(received).toEqual(['before']);
  });

  test('close is cut plus the socket being gone', () => {
    const received: string[] = [];
    const ws = new PipeWs(data, (raw) => received.push(raw));
    ws.close();
    ws.send('after');
    expect(ws.closed).toBe(true);
    expect(received).toEqual([]);
  });

  // Backpressure is a real socket's. A harness that invented one would fail a test for a reason no
  // production node would — and `SyncSocket` reads this number to decide whether to drop a frame.
  test('there is no backpressure, and topic membership is the hub’s', () => {
    const ws = new PipeWs(data, () => undefined);
    expect(ws.getBufferedAmount()).toBe(0);
    expect(ws.subscribe()).toBeUndefined();
    expect(ws.unsubscribe()).toBeUndefined();
    expect(ws.data).toBe(data);
  });
});
