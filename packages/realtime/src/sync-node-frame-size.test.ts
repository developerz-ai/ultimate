// `maxFrameBytes` is the sync node's own refusal, not only Bun's `maxPayloadLength`: on a listener
// shared with a device socket the listener's limit is the WIDEST mount's, so a node that left the
// check to Bun accepted frames eight times its declared bound.

import { describe, expect, test } from 'bun:test';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry, type WsLike } from './socket';
import { type SyncWs, syncNode, type WsData } from './sync-node';
import { PROTOCOL_VERSION } from './sync-protocol';

class FakeWs implements WsLike {
  readonly sent: string[] = [];
  readonly closed: { code: number | undefined; reason: string | undefined }[] = [];
  data!: WsData;
  send(raw: string): number {
    this.sent.push(raw);
    return raw.length;
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function open(maxFrameBytes: number) {
  const transport = new InProcessTransport();
  const sockets = new SocketRegistry();
  const sync = syncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: 'build-1',
    sockets,
    maxFrameBytes,
  });
  const ws = new FakeWs();
  ws.data = { socketId: 'sock-1', clientBuildId: 'build-1' };
  const typed = ws as SyncWs & FakeWs;
  sync.websocket.open(typed);
  const push = (message: string | Uint8Array) => sync.websocket.message(typed, message);
  return { ws, push };
}

const unsubscribe = JSON.stringify({ type: 'unsubscribe', v: PROTOCOL_VERSION, sid: 's1' });

describe('unit · sync node frame bound', () => {
  test('a text frame over maxFrameBytes closes the socket 1009 and is never routed', async () => {
    const { ws, push } = open(64);
    push(`${unsubscribe}${' '.repeat(64)}`);
    await flush();
    expect(ws.closed).toEqual([{ code: 1009, reason: 'frame over maxFrameBytes' }]);
    expect(ws.sent).toEqual([]);
  });

  test('a binary frame is measured in bytes, the same bound', async () => {
    const { ws, push } = open(64);
    push(new Uint8Array(65));
    await flush();
    expect(ws.closed).toEqual([{ code: 1009, reason: 'frame over maxFrameBytes' }]);
  });

  test('a frame at the bound is routed, multi-byte text counted as UTF-8', async () => {
    const exact = open(unsubscribe.length);
    exact.push(unsubscribe);
    await flush();
    expect(exact.ws.closed).toEqual([]);
    const wide = open(unsubscribe.length + 1);
    wide.push(`${unsubscribe}é`);
    await flush();
    expect(wide.ws.closed).toEqual([{ code: 1009, reason: 'frame over maxFrameBytes' }]);
  });
});
