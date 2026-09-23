// The one `new WebSocket` adapter: four handlers and a send, passed through untouched, and the dial
// URL that carries the build. A fake `WebSocket` stands in for the browser's, restored after.

import { afterEach, describe, expect, test } from 'bun:test';
import { browserSocket, dialUrl } from './browser-socket';

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readonly sent: string[] = [];
  readonly closes: [number | undefined, string | undefined][] = [];
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
  }
}

const realWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = realWebSocket;
  FakeWebSocket.last = null;
});

function dialled(url: string): { socket: ReturnType<typeof browserSocket>; ws: FakeWebSocket } {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const socket = browserSocket(url);
  const ws = FakeWebSocket.last;
  if (ws === null) return expect.unreachable('browserSocket opened no WebSocket');
  return { socket, ws };
}

describe('browserSocket', () => {
  test('dials the url it is given, and send/close reach the socket as they were called', () => {
    const { socket, ws } = dialled('ws://node.test/_x/sync?build=b1');
    expect(ws.url).toBe('ws://node.test/_x/sync?build=b1');
    socket.send('{"type":"hello"}');
    socket.close(4000, 'silent');
    expect(ws.sent).toEqual(['{"type":"hello"}']);
    expect(ws.closes).toEqual([[4000, 'silent']]);
  });

  test('open, message and close reach their handlers — the data as text, the close by code', () => {
    const { socket, ws } = dialled('ws://node.test/_x/sync');
    const seen: unknown[] = [];
    socket.onOpen(() => seen.push('open'));
    socket.onMessage((data) => seen.push(data));
    socket.onClose((code) => seen.push(code));
    ws.onopen?.();
    ws.onmessage?.({ data: 42 });
    ws.onclose?.({ code: 1006 });
    expect(seen).toEqual(['open', '42', 1006]);
  });

  test('bufferedAmount is read from the socket at the time it is asked', () => {
    const { socket, ws } = dialled('ws://node.test/_x/sync');
    expect(socket.bufferedAmount).toBe(0);
    ws.bufferedAmount = 512;
    expect(socket.bufferedAmount).toBe(512);
  });
});

describe('dialUrl', () => {
  test('the build rides the dial, joined to a url that already has a query', () => {
    expect(dialUrl({ url: 'ws://node.test/_x/sync', buildId: 'b 1' })).toBe(
      'ws://node.test/_x/sync?build=b%201',
    );
    expect(dialUrl({ url: 'ws://node.test/_x/sync?shard=2', buildId: 'b1' })).toBe(
      'ws://node.test/_x/sync?shard=2&build=b1',
    );
  });
});
