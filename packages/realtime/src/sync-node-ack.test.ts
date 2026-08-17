// The failure ack. A client looks a failure up by `ack.ref` — `queue.fail(frame.ref)` finds the
// optimistic write to roll back by its idempotency key — so an ack that carries the SOCKET id
// names something no queue can hold, and the whole rollback path is inert end to end: the write
// stays on screen, the mutation stays queued, and nothing ever says otherwise.

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

class MutationFailed extends Error {
  readonly code = 'X_INVARIANT_VIOLATED';
  readonly cause = 'the row no longer exists';
  readonly fix = 'refetch the post before liking it';
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
    onMutate: async () => {
      throw new MutationFailed('mutation refused');
    },
  });
  const ws = new FakeWs();
  ws.data = { socketId: 'sock-1', clientBuildId: 'build-1' };
  const typed = ws as SyncWs & FakeWs;
  sync.websocket.open(typed);
  return { sync, ws: typed };
}

describe('an ack for a failed frame', () => {
  test('refers to the mutation key, not to the socket', async () => {
    const { sync, ws } = node();

    sync.websocket.message(
      ws,
      encode({
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
    if (ack?.type !== 'ack') throw new MutationFailed('expected an ack frame');
    expect(ack.ref).toBe('like:p1:alice');
    expect(ack.error?.code).toBe('X_INVARIANT_VIOLATED');
    expect(ack.lsn).toBeNull();
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
    if (ack?.type !== 'ack') throw new MutationFailed('expected an ack frame');
    expect(ack.ref).toBe('sid-7');
    expect(ack.error?.code).toBe('X_LIVE_QUERY_UNKNOWN');
  });

  test('falls back to the socket only when the frame could not be read at all', async () => {
    const { sync, ws } = node();

    sync.websocket.message(ws, 'not json');
    await flush();

    const ack = ws.frames[0];
    if (ack?.type !== 'ack') throw new MutationFailed('expected an ack frame');
    expect(ack.ref).toBe('sock-1');
    expect(ack.error?.code).toBe('X_PROTOCOL_VERSION');
  });
});
