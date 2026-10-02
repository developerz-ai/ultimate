// A live subscription refused AFTER it was served: the frame a refused `subscribe` gets — an `ack`
// whose `ref` is the sid — sent by the node itself, so the client's window renders `failed` with
// the code, cause and fix instead of going quiet. `sync-node.ts` sends the same frame when a
// subscribe frame throws.

import { logger } from '@ultimat3/core';
import type { SyncSocket } from './socket';
import { PROTOCOL_VERSION, toWireError } from './sync-protocol';

export function refuseSubscription(socket: SyncSocket, sid: string, error: unknown): void {
  const sent = socket.send({
    type: 'ack',
    v: PROTOCOL_VERSION,
    ref: sid,
    lsn: null,
    error: toWireError(error),
  });
  // Read, never assumed: the subscription is already gone, so a dropped refusal leaves a client
  // waiting on a window nothing serves — the log is the only trace it would leave.
  if (!sent) logger.warn('sync.refusal_dropped', { socketId: socket.id, sid });
}
