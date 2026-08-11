// The `connections` gauge `docker/helm`'s sync HPA scales on. A gauge is only useful if it comes
// back DOWN, so every test here ends by asserting zero on a path a connection can actually die on.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type Clock, collectMetrics, resetMetrics } from '@ultimat3/core';
import { CLOSE, SocketRegistry, SyncSocket, type WsLike } from './socket';

class FakeWs implements WsLike {
  closedWith: number | undefined;
  send(data: string): number {
    return data.length;
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

/** What a scrape would read, straight off the collector — not an internal counter of our own. */
function liveConnections(): number {
  const metric = collectMetrics().metrics.find((each) => each.descriptor.name === 'connections');
  return metric?.points[0]?.value ?? 0;
}

function socketOn(registry: SocketRegistry, id: string, clock?: Clock): SyncSocket {
  const socket = new SyncSocket({
    ws: new FakeWs(),
    id,
    clientBuildId: 'build-1',
    serverBuildId: 'build-1',
    ...(clock === undefined ? {} : { clock }),
  });
  registry.add(socket);
  return socket;
}

beforeEach(() => {
  resetMetrics();
});

describe('the connections gauge follows the socket table', () => {
  test('counts up on add and back to zero on a normal close', () => {
    const registry = new SocketRegistry();
    socketOn(registry, 'a');
    socketOn(registry, 'b');
    expect(liveConnections()).toBe(2);

    registry.remove('a');
    registry.remove('b');
    expect(liveConnections()).toBe(0);
    expect(registry.count).toBe(0);
  });

  test('returns to zero after an ABNORMAL close, and never goes below it', () => {
    const registry = new SocketRegistry();
    const socket = socketOn(registry, 'a');
    expect(liveConnections()).toBe(1);

    // No goodbye frame, no protocol close: backpressure kills the socket and the transport reports
    // the close afterwards. That report can arrive twice — Bun's callback plus a drain sweeping
    // the same id — and a gauge that decrements per call would go negative and stay there.
    socket.close(CLOSE.overloaded, 'backpressure');
    registry.remove('a');
    registry.remove('a');

    expect(liveConnections()).toBe(0);
    expect(registry.count).toBe(0);
  });

  test('the idle sweep decrements too — the close path with no callback behind it', () => {
    let ms = 0;
    const clock: Clock = { now: () => new Date(ms), monotonic: () => ms };
    const registry = new SocketRegistry({ clock, idleTimeoutMs: 1_000 });
    socketOn(registry, 'stale', clock);
    socketOn(registry, 'fresh', clock);
    expect(liveConnections()).toBe(2);

    ms = 5_000;
    registry.get('fresh')?.touch();
    expect(registry.sweepIdle().map((socket) => socket.id)).toEqual(['stale']);
    expect(liveConnections()).toBe(1);

    registry.remove('fresh');
    expect(liveConnections()).toBe(0);
  });

  test('a reconnect that reuses an id replaces the socket without inventing a connection', () => {
    const registry = new SocketRegistry();
    socketOn(registry, 'a');
    socketOn(registry, 'a');
    expect(liveConnections()).toBe(1);

    registry.remove('a');
    expect(liveConnections()).toBe(0);
  });
});
