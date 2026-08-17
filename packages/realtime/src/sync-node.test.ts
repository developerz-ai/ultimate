// `listenSyncNode` binds a real socket, so this file is the only place realtime opens one. It
// covers the seam between the node and the OS: which address the listener reports, and whether a
// client that trusts that address actually lands on this node.

import { afterEach, describe, expect, test } from 'bun:test';
import { resetListeners } from '@ultimat3/core';
import { RingChangeBuffer } from './change-buffer';
import { ChannelHub } from './channel';
import { InProcessTransport } from './fanout';
import { LiveQueryRegistry } from './live-query';
import { SocketRegistry } from './socket';
import { listenSyncNode } from './sync-listen';
import { createSyncNode, type SyncNode } from './sync-node';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';

const BUILD_ID = 'build-1';

function node(): SyncNode {
  const sockets = new SocketRegistry();
  const transport = new InProcessTransport();
  return createSyncNode({
    hub: new ChannelHub({ transport, sockets }),
    registry: new LiveQueryRegistry({ source: new RingChangeBuffer() }),
    transport,
    buildId: BUILD_ID,
    sockets,
  });
}

/** Resolves on `open`, rejects on `error` — never hangs the suite waiting on a socket. */
function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve();
    });
    ws.addEventListener('error', () => {
      reject(new Error(`websocket did not open: ${ws.url}`));
    });
  });
}

/** The node's answer to one frame. A reply is the only proof the socket reached *this* node. */
function replyTo(ws: WebSocket, frame: Frame): Promise<Frame> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event: MessageEvent) => {
      resolve(decode(String(event.data)));
    });
    ws.addEventListener('error', () => {
      reject(new Error('websocket errored before replying'));
    });
    ws.send(encode(frame));
  });
}

afterEach(() => {
  resetListeners();
});

describe('listenSyncNode reports the address it bound', () => {
  test('port 0 answers with the real port, spoken as ws://', async () => {
    const sync = node();
    await sync.start();
    const listener = listenSyncNode(sync, { port: 0 });

    const url = new URL(listener.url);
    expect(url.protocol).toBe('ws:');
    // The whole point: the caller asked for "any port" and gets told which one it got.
    expect(Number(url.port)).toBeGreaterThan(0);
    expect(listener.url).toBe(`ws://${url.host}`);

    listener.stop();
    await sync.stop();
  });

  test('a client that trusts the reported url lands on this node', async () => {
    const sync = node();
    await sync.start();
    const listener = listenSyncNode(sync, { port: 0 });

    const ws = new WebSocket(`${listener.url}/_x/sync`);
    await opened(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const reply = await replyTo(ws, {
      type: 'hello',
      v: PROTOCOL_VERSION,
      buildId: BUILD_ID,
      sessionId: null,
      actorId: null,
    });
    expect(reply.type).toBe('hello');
    expect(sync.sockets.count).toBe(1);

    ws.close();
    listener.stop();
    await sync.stop();
  });
});
