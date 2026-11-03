// `SyncSocket.send` against a REAL Bun WebSocket, not a scripted one: the claim `channel_frames_
// dropped_total` makes is that every frame it counts never reached the client, and every frame it
// does not count did. Only a real server with a real buffer can say whether `-1` was a drop.

import { afterEach, describe, expect, test } from 'bun:test';
import { markListening } from '@ultimat3/core';
import { SyncSocket, type WsLike } from './socket';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

/** 60 MB: past any loopback's send and receive buffers, 32 MB between them at Linux's tcp maximums. */
const MAX_FRAMES = 400;
const DROPS_WANTED = 5;
const PAD = 'x'.repeat(150 * 1024);

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

/** One `events` frame per index, each carrying 150 kB. */
const frameAt = (index: number): Frame => ({
  type: 'events',
  v: PROTOCOL_VERSION,
  channel: 'wire.test',
  event: { index, pad: PAD },
});

describe('unit · what a real socket says about a frame', () => {
  test('a frame counted as dropped never arrives; every other frame does', async () => {
    const sent = new Set<number>();
    let attempted = 0;
    let socket: SyncSocket | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request, srv) =>
        srv.upgrade(request) ? undefined : new Response('upgrade', { status: 426 }),
      websocket: {
        open(ws) {
          const adapter: WsLike = {
            send: (data: string) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            subscribe: () => undefined,
            unsubscribe: () => undefined,
            getBufferedAmount: () => ws.getBufferedAmount(),
          };
          socket = new SyncSocket({
            ws: adapter,
            id: 'wire',
            clientBuildId: 'b',
            serverBuildId: 'b',
            maxDroppedFrames: MAX_FRAMES,
          });
          // Until the buffer really overruns: how much a kernel absorbs first is the machine's own
          // (tcp autotuning took a fixed 6 MB whole, and no frame was ever dropped).
          while (attempted < MAX_FRAMES && socket.droppedFrames < DROPS_WANTED) {
            if (socket.send(frameAt(attempted))) sent.add(attempted);
            attempted += 1;
          }
        },
        message() {},
      },
    });
    const release = markListening(server.url.origin);
    stop = () => {
      release();
      server.stop(true);
    };

    const received = new Set<number>();
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(quiet);
        quiet = setTimeout(() => {
          client.close();
          resolve();
        }, 300);
      };
      client.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { event: { index: number } };
        received.add(frame.event.index);
        if (received.size === sent.size) settle();
      };
      client.onerror = () => reject(new TypeError('the test socket failed to connect'));
      client.onopen = settle;
    });

    expect(socket?.sentFrames).toBe(sent.size);
    expect(socket?.droppedFrames).toBe(attempted - sent.size);
    // The claim itself: nothing counted as dropped arrived, and nothing reported sent went missing.
    expect([...received].sort((a, b) => a - b)).toEqual([...sent].sort((a, b) => a - b));
    // Non-vacuity: the buffer really was overrun, so both branches were taken.
    expect(socket?.droppedFrames ?? 0).toBeGreaterThan(0);
  });
});
