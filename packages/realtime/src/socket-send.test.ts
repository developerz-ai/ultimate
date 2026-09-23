// `SyncSocket.send` answers whether the frame LEFT, and its only evidence is `WsLike.send`'s
// return. Discarded, every drop between the buffered-amount check and the write read as a
// delivery: `live-fanout` advanced the subscriber's cursor past a patch nobody received, and the
// desync mark that would have re-snapshotted it was never taken.

import { describe, expect, test } from 'bun:test';
import { CLOSE, SocketRegistry, SyncSocket, type WsLike } from './socket';
import { DROP_WINDOW_MS } from './socket-drops';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** A socket whose runtime answer is scripted, which is the whole point — see `socket.test.ts`. */
class ScriptedWs implements WsLike {
  answer = 1;
  sent = 0;
  closedWith: number | undefined;
  send(data: string): number {
    this.sent += 1;
    return this.answer === 1 ? data.length : this.answer;
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const frame: Frame = {
  type: 'patch',
  v: PROTOCOL_VERSION,
  sid: 's1',
  patches: [],
  lsn: '0'.repeat(24),
};

function socketOn(ws: ScriptedWs, maxDroppedFrames?: number): SyncSocket {
  return new SyncSocket({
    ws,
    id: 'a',
    clientBuildId: 'b1',
    serverBuildId: 'b1',
    ...(maxDroppedFrames === undefined ? {} : { maxDroppedFrames }),
  });
}

describe('unit · what a send answers', () => {
  test('an accepted frame is true and counts as sent', () => {
    const ws = new ScriptedWs();
    const socket = socketOn(ws);
    expect(socket.send(frame)).toBe(true);
    expect(socket.sentFrames).toBe(1);
    expect(socket.droppedFrames).toBe(0);
  });

  test('a frame the runtime DROPPED is false and never counts as sent', () => {
    // Bun answers `0` for a message it discarded — the socket closed between the buffered-amount
    // check and this write, which is the whole window this read exists to cover.
    const ws = new ScriptedWs();
    ws.answer = 0;
    const socket = socketOn(ws);
    expect(socket.send(frame)).toBe(false);
    expect(socket.sentFrames).toBe(0);
    expect(socket.droppedFrames).toBe(1);
  });

  // Bun answers `-1` when the frame was QUEUED under backpressure — it will be delivered. Counted as
  // a drop it sent a spurious `replay-gap`, marked a healthy subscriber out of sync, and closed a
  // socket after 33 such "drops" over its whole life.
  test('a frame Bun queued under backpressure (-1) was sent, and is never a drop', () => {
    const ws = new ScriptedWs();
    ws.answer = -1;
    const socket = socketOn(ws, 2);
    for (let i = 0; i < 10; i += 1) expect(socket.send(frame)).toBe(true);
    expect(socket.sentFrames).toBe(10);
    expect(socket.droppedFrames).toBe(0);
    expect(ws.closedWith).toBeUndefined();
  });

  test('the drop ceiling is per window, never per lifetime', () => {
    const ws = new ScriptedWs();
    ws.answer = 0;
    let ms = 0;
    const socket = new SyncSocket({
      ws,
      id: 'a',
      clientBuildId: 'b1',
      serverBuildId: 'b1',
      maxDroppedFrames: 2,
      clock: { now: () => new Date(ms), monotonic: () => ms },
    });
    // Two drops a window, for many windows: a long-lived socket on a flaky link stays open.
    for (let window = 0; window < 20; window += 1) {
      socket.send(frame);
      socket.send(frame);
      ms += DROP_WINDOW_MS + 1;
    }
    expect(socket.droppedFrames).toBe(40);
    expect(ws.closedWith).toBeUndefined();
    // Three inside one window is a socket that is drowning.
    socket.send(frame);
    socket.send(frame);
    socket.send(frame);
    expect(ws.closedWith).toBe(CLOSE.overloaded);
  });

  test('a socket the runtime keeps refusing is closed, exactly as backpressure closes one', () => {
    const ws = new ScriptedWs();
    ws.answer = 0;
    const socket = socketOn(ws, 2);
    socket.send(frame);
    socket.send(frame);
    expect(ws.closedWith).toBeUndefined();
    socket.send(frame);
    expect(ws.closedWith).toBe(CLOSE.overloaded);
  });
});

describe('unit · what the registry does with the answer', () => {
  test('a dropped channel frame is counted rather than reported as delivered', () => {
    const ws = new ScriptedWs();
    const registry = new SocketRegistry();
    const socket = socketOn(ws);
    registry.add(socket);
    registry.joinTopic(socket, 'org.o1.typing');

    ws.answer = 0;
    expect(registry.deliver('org.o1.typing', frame)).toBe(0);
    expect(registry.droppedChannelFrames).toBe(1);
  });
});
