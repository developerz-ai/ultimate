// Every ceiling a socket compares against, refused when it is not a finite number. `??` guards
// only nullish and `NaN` is not, so `Number(process.env.SYNC_IDLE_MS)` on an unset variable
// reaches the comparison intact — and every comparison against `NaN` is false, which turns each
// of these guards off in silence. The frame budget's own half lives in `thundering-herd.test.ts`.

import { describe, expect, test } from 'bun:test';
import { frozenClock, UltimateError } from '@ultimat3/core';
import { CLOSE, SocketRegistry, SyncSocket, type WsLike } from './socket';
import { type Frame, PROTOCOL_VERSION } from './sync-protocol';

class BackedUpWs implements WsLike {
  buffered = 0;
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
    return this.buffered;
  }
}

const frame: Frame = {
  type: 'patch',
  v: PROTOCOL_VERSION,
  sid: 's1',
  patches: [],
  lsn: '0'.repeat(24),
};

/** Every shape `Number(...)` / `parseInt` / JSON hands a config reader that no `??` can catch. */
const NOT_A_CEILING = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

const build = (patch: Record<string, number>): (() => SyncSocket) =>
  function open(): SyncSocket {
    return new SyncSocket({
      ws: new BackedUpWs(),
      id: 'a',
      clientBuildId: 'b',
      serverBuildId: 'b',
      ...patch,
    });
  };

describe('a socket built on a number that is not a number', () => {
  test('a non-finite maxBufferedBytes is refused, because backpressure would never trip', () => {
    // MEASURED before the guard: with 10 MB already queued, `getBufferedAmount() > NaN` is false,
    // so `send()` answered TRUE — the frame is dropped by the runtime and the caller is told it
    // left, which is the divergence `socket-send.test.ts` exists for, arriving through the option.
    for (const maxBufferedBytes of NOT_A_CEILING) {
      expect(build({ maxBufferedBytes })).toThrow(UltimateError);
    }
  });

  test('a non-finite maxDroppedFrames is refused, because the overload close would never fire', () => {
    for (const maxDroppedFrames of NOT_A_CEILING) {
      expect(build({ maxDroppedFrames })).toThrow(UltimateError);
    }
  });

  test('the refusal names the option, so it is one edit', () => {
    let thrown: unknown;
    try {
      build({ maxBufferedBytes: Number.NaN })();
    } catch (error: unknown) {
      thrown = error;
    }
    const rendered = thrown instanceof UltimateError ? `${thrown.cause} ${thrown.fix}` : '';
    expect(rendered).toContain('maxBufferedBytes');
    expect(rendered).toContain('NaN');
  });

  test('a finite ceiling still drops and still closes — the guard refuses numbers, not sockets', () => {
    // Non-vacuity: a constructor that threw on everything would satisfy every assertion above.
    const ws = new BackedUpWs();
    ws.buffered = 4096;
    const socket = new SyncSocket({
      ws,
      id: 'a',
      clientBuildId: 'b',
      serverBuildId: 'b',
      maxBufferedBytes: 1024,
      maxDroppedFrames: 1,
    });
    expect(socket.send(frame)).toBe(false);
    expect(socket.send(frame)).toBe(false);
    expect(socket.droppedFrames).toBe(2);
    expect(ws.closedWith).toBe(CLOSE.overloaded);
  });
});

describe('a registry built on an idle budget that is not a number', () => {
  test('a non-finite idleTimeoutMs is refused, because the sweep would evict nobody', () => {
    // MEASURED before the guard: a socket idle for 10,000,000 ms was not in `idle()`, because
    // `idleFor(now) > NaN` is false. A client whose frame loop is wedged but whose TCP stack still
    // answers Bun's pings then holds its grant, its subscriptions and its topic membership for the
    // life of the process — the exact failure this budget's own docstring says it exists to stop.
    for (const idleTimeoutMs of NOT_A_CEILING) {
      expect(() => new SocketRegistry({ idleTimeoutMs })).toThrow(UltimateError);
    }
  });

  test('a finite idle budget still sweeps', () => {
    const clock = frozenClock();
    const registry = new SocketRegistry({ clock, idleTimeoutMs: 1_000 });
    registry.add(
      new SyncSocket({
        ws: new BackedUpWs(),
        id: 'a',
        clientBuildId: 'b',
        serverBuildId: 'b',
        clock,
      }),
    );
    expect(registry.idle()).toEqual([]);
    clock.advance(1_001);
    expect(registry.idle().map((socket) => socket.id)).toEqual(['a']);
  });
});
