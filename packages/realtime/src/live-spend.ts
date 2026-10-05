// When a live subscribe spends the read's declared `rateLimit:`, and against whom. Split from
// `live-query.ts` at its size ceiling: the registry decides WHAT is served, this decides what it
// costs — once per subscribe that reads, on the node's clock, keyed by the socket's own address.

import type { Clock } from '@ultimat3/core';
import type { LiveCursor } from './cursor';
import type { JsonValue } from './json';
import type { LiveQueryDefinition } from './live-contract';
import type { SyncSocket } from './socket';

export interface SubscribeArgs {
  readonly socket: SyncSocket;
  readonly name: string;
  readonly input: JsonValue;
  readonly sid?: string;
  readonly cursor?: LiveCursor | null;
}

/**
 * One subscribe's bill, shared by every pass of it. `subscribe` serves AGAIN when the socket's
 * actor is replaced under it, and that second pass is the same subscription: spending there
 * charged one subscribe twice.
 */
export interface Charge {
  due: boolean;
}

/**
 * Spend once, then never again for this subscribe — called by the registry immediately before
 * any DATABASE READ this subscriber causes: a cold snapshot, a resume that fell back to one, or a
 * delta resume onto an entry nothing has read yet. Only a real in-window delta served out of the
 * ring is free. Never decided from the cursor: its `qid` is computable from the query, the input
 * and the org, so a cursor is a client's claim to a window, not proof it held one — trusting it
 * made every subscribe+unsubscribe cycle a free read. `due` drops before the await, so a pass
 * racing this one (the re-auth retry) cannot pay as well.
 */
export async function spendOnce(
  definition: LiveQueryDefinition,
  socket: SyncSocket,
  charge: Charge,
  clock: Clock,
): Promise<void> {
  if (!charge.due) return;
  charge.due = false;
  await definition.spend?.({
    actor: socket.actor,
    clientAddress: socket.clientAddress,
    nowMs: clock.now().getTime(),
  });
}
