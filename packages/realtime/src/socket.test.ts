// The `connections` gauge `docker/helm`'s sync HPA scales on. A gauge is only useful if it comes
// back DOWN, so every test here ends by asserting zero on a path a connection can actually die on.

import { beforeEach, describe, expect, test } from 'bun:test';
import { type Clock, collectMetrics, resetMetrics } from '@ultimat3/core';
import { CLOSE, idleSweepPeriodMs, SocketRegistry, SyncSocket, type WsLike } from './socket';

class FakeWs implements WsLike {
  closedWith: number | undefined;
  /**
   * Bun's own contract, and the reason `send` is declared `: number`: bytes accepted, `0` for a
   * message the runtime dropped, `-1` under backpressure. A fake that answered `data.length`
   * whatever its state could not tell an accepted frame from a dropped one, so no test here could
   * see the bug — the socket closes, the write returns `0`, and the caller was told `true`.
   */
  send(data: string): number {
    return this.closedWith === undefined ? data.length : 0;
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

  test("the idle budget names who is past it, and evicting is the caller's", () => {
    let ms = 0;
    const clock: Clock = { now: () => new Date(ms), monotonic: () => ms };
    const registry = new SocketRegistry({ clock, idleTimeoutMs: 1_000 });
    socketOn(registry, 'stale', clock);
    socketOn(registry, 'fresh', clock);
    expect(liveConnections()).toBe(2);

    ms = 5_000;
    registry.get('fresh')?.touch();
    expect(registry.idle().map((socket) => socket.id)).toEqual(['stale']);
    // A QUERY: this table is three of the five things a socket holds, and a sweep that removed
    // here would leave its presence membership on the shared set and its live subscriptions in
    // the registry. `sync-node`'s `teardown` is what releases all five — `sync-drain.test.ts`.
    expect(liveConnections()).toBe(2);

    registry.remove('stale');
    registry.remove('fresh');
    expect(liveConnections()).toBe(0);
  });

  test('an NTP step BACKWARD does not spare a socket that has been silent throughout', () => {
    // Two clocks that can disagree, because that is exactly what an NTP correction produces: real
    // elapsed time only ever moves forward, the wall clock is whatever the daemon last wrote.
    let wall = 1_700_000_000_000;
    let mono = 0;
    const clock: Clock = { now: () => new Date(wall), monotonic: () => mono };
    const registry = new SocketRegistry({ clock, idleTimeoutMs: 1_000 });
    const socket = socketOn(registry, 'stale', clock);
    // `openedAt` stays on the WALL clock: it is an exposed instant a human reads, and a monotonic
    // number is meaningless outside this process.
    expect(socket.openedAt).toBe(wall);

    // Two seconds of real silence, during which the daemon steps the wall clock five seconds back.
    mono += 2_000;
    wall += 2_000 - 5_000;

    // Measured on the wall clock this socket has been idle for MINUS three seconds, so a dead
    // connection keeps its grants, its subscriptions and its topic membership indefinitely.
    expect(registry.idle().map((each) => each.id)).toEqual(['stale']);

    registry.remove('stale');
    expect(liveConnections()).toBe(0);
  });

  test('an NTP step FORWARD does not evict a socket that is still talking', () => {
    let wall = 1_700_000_000_000;
    let mono = 0;
    const clock: Clock = { now: () => new Date(wall), monotonic: () => mono };
    const registry = new SocketRegistry({ clock, idleTimeoutMs: 1_000 });
    socketOn(registry, 'busy', clock);

    mono += 100;
    wall += 100;
    registry.get('busy')?.touch();

    // A tenth of the budget of real time later, with a one-minute correction applied in between.
    mono += 100;
    wall += 100 + 60_000;

    // On the wall clock this socket looks a minute silent, so the sweep closes a connection that
    // routed a frame 100ms ago — the eviction the client experiences as a spurious reconnect.
    expect(registry.idle()).toEqual([]);

    registry.remove('busy');
    expect(liveConnections()).toBe(0);
  });

  test('the sweep period is a quarter of the budget, never under a second', () => {
    expect(idleSweepPeriodMs(120_000)).toBe(30_000);
    expect(idleSweepPeriodMs(1_000)).toBe(1_000);
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
