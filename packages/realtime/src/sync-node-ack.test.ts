// The failure ack. A client looks a refusal up by `ack.ref` — the sid of the subscription the node
// refused — so an ack carrying the SOCKET id would fail no window and every live read would sit in
// `loading` forever. The socket id is only for a frame nothing could read, including a `mutate`
// from a client one major behind: the socket carries no writes since protocol 3.

import { describe, expect, test } from 'bun:test';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, type WsLike } from './socket';
import { createSyncNode, type SyncNode, type SyncWs, type WsData } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  data!: WsData;
  send(raw: string): number {
    this.frames.push(decode(raw));
    return raw.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** The dispatch is fire-and-forget, so a test reads its frames after the queue drains. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function node(): { sync: SyncNode; ws: SyncWs & FakeWs } {
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry();
  const sync = createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: 'build-1',
    sockets,
  });
  const ws = new FakeWs();
  ws.data = { socketId: 'sock-1', clientBuildId: 'build-1' };
  const typed = ws as SyncWs & FakeWs;
  sync.websocket.open(typed);
  return { sync, ws: typed };
}

describe('an ack for a failed frame', () => {
  test('a `mutate` frame — the write path protocol 3 deleted — is X_PROTOCOL_VERSION', async () => {
    const { sync, ws } = node();

    sync.websocket.message(
      ws,
      JSON.stringify({
        type: 'mutate',
        v: PROTOCOL_VERSION,
        key: 'like:p1:alice',
        seq: 1,
        name: 'likePost',
        input: { postId: 'p1' },
      }),
    );
    await flush();

    const ack = ws.frames[0];
    expect(ack?.type).toBe('ack');
    if (ack?.type !== 'ack') return;
    // Nothing on the node can name a mutation any more, so the refusal names the socket, and its
    // instruction is the rebuild a client one major behind needs.
    expect(ack.ref).toBe('sock-1');
    expect(ack.error?.code).toBe('X_PROTOCOL_VERSION');
  });

  test('refers to the sid when a subscribe fails', async () => {
    const { sync, ws } = node();

    sync.websocket.message(
      ws,
      encode({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'add',
        sid: 'sid-7',
        target: { kind: 'query', qid: 'nothing-registered', input: null, cursor: null },
      }),
    );
    await flush();

    const ack = ws.frames[0];
    expect(ack?.type).toBe('ack');
    if (ack?.type !== 'ack') return;
    expect(ack.ref).toBe('sid-7');
    expect(ack.error?.code).toBe('X_LIVE_QUERY_UNKNOWN');
  });

  test('falls back to the socket only when the frame could not be read at all', async () => {
    const { sync, ws } = node();

    sync.websocket.message(ws, 'not json');
    await flush();

    const ack = ws.frames[0];
    expect(ack?.type).toBe('ack');
    if (ack?.type !== 'ack') return;
    expect(ack.ref).toBe('sock-1');
    expect(ack.error?.code).toBe('X_PROTOCOL_VERSION');
  });
});
