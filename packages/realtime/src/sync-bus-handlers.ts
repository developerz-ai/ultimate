// What a sync node does with the change bus: one change in, fanned to the live queries and the
// declared channels; a gap or a reconnect, answered by invalidating both. Split out of
// `sync-node.ts` so the node's lifecycle (start, stop, drain) stays readable in one file.

import { logger } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import { detach } from './detach';
import type { LiveQueryRegistry } from './live-query';
import { parseEnvelope, type SeqGapDetector } from './replicator-envelope';

export interface SyncBus {
  readonly registry: LiveQueryRegistry;
  readonly hub: ChannelHub;
  readonly gaps: SeqGapDetector;
}

/** The handler a node subscribes to `CHANGE_SUBJECT_ALL` with. */
export function changeHandler(bus: SyncBus): (payload: string) => void {
  return (payload) => {
    const envelope = parseEnvelope(payload);
    if (!envelope) return;
    // Fanout is at-most-once over core NATS, so a reconnect is changes this node never saw.
    // Nothing downstream could notice: no window's lsn moved, so no cursor moved, so nothing
    // ever asked for a re-snapshot. A gap invalidates every window here instead, and the
    // subscribers are re-served on the next change to each query.
    if (bus.gaps.observe(envelope)) {
      const marked = bus.registry.invalidate();
      // Channels too: their seq is minted from what this node sees, so the hole is invisible
      // to a ring that would otherwise replay across it as complete history.
      const channelGaps = bus.hub.invalidate();
      logger.warn('live.change_gap', {
        entity: envelope.change.entity,
        desynced: marked,
        channelGaps,
      });
    }
    // Not awaited: the bus handler must return before the next change, and ordering is the
    // registry's — one serial lane per query id. What this call site owes is the failure. An
    // unhandled rejection here is a fanout that reached nobody, reported as a dead process.
    detach(bus.registry.deliver(envelope.change), 'live.deliver', envelope.change.entity);
    // The same stream feeds the declared channels: a write names no channel (axiom 2), and the
    // hub turns this change into `records` frames on every channel it touches.
    bus.hub.deliverChange(envelope.change);
  };
}

/**
 * A bus that reconnected is changes this node never saw, and the gap detector only notices on the
 * NEXT message: with no later write, every window and cursor here stayed behind and every new
 * subscriber joined the stale window. Said by the transport, repaired now.
 */
export function reconnectHandler(bus: SyncBus): () => void {
  return () => {
    bus.gaps.forget();
    const marked = bus.registry.invalidate();
    const channelGaps = bus.hub.invalidate();
    logger.warn('live.bus_reconnected', { desynced: marked, channelGaps });
  };
}
