// The refusal a node sends for a subscription it can no longer serve: the frame shape a refused
// subscribe gets, and a trace when even that frame cannot leave.

import { describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { refuseSubscription } from './live-refusal';
import { SyncSocket, type WsLike } from './socket';
import { decode, type Frame } from './sync-protocol';

class FakeWs implements WsLike {
  readonly frames: Frame[] = [];
  constructor(private readonly accepts: boolean) {}
  send(data: string): number {
    if (!this.accepts) return 0;
    this.frames.push(decode(data));
    return data.length;
  }
  close(): void {}
  subscribe(): void {}
  unsubscribe(): void {}
  getBufferedAmount(): number {
    return 0;
  }
}

/** Stands in for a policy store's timeout: a FOREIGN error, so it extends `Error` on purpose. */
class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
  readonly fix = 'raise the pool, or retry';
}

const socketOn = (ws: FakeWs): SyncSocket =>
  new SyncSocket({ ws, id: 's-1', clientBuildId: 'b', serverBuildId: 'b' });

describe('refuseSubscription', () => {
  test('sends an ack refusing the sid, with the error contract', () => {
    const ws = new FakeWs(true);
    refuseSubscription(socketOn(ws), 'sub-1', new PoolTimeout('timed out'));
    expect(ws.frames).toEqual([
      {
        type: 'ack',
        v: expect.any(Number),
        ref: 'sub-1',
        lsn: null,
        error: { code: 'X_DB_TIMEOUT', cause: expect.any(String), fix: 'raise the pool, or retry' },
      },
    ]);
  });

  test('a refusal that cannot leave is logged, naming the socket and the sid', () => {
    const warn = spyOn(logger, 'warn');
    try {
      refuseSubscription(socketOn(new FakeWs(false)), 'sub-1', new PoolTimeout('timed out'));
      expect(warn).toHaveBeenCalledWith('sync.refusal_dropped', { socketId: 's-1', sid: 'sub-1' });
    } finally {
      warn.mockRestore();
    }
  });
});
