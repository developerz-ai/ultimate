// What a sync node does with the change bus: one change in, fanned to the live queries and the
// declared channels; a gap or a reconnect, answered by invalidating both; and one producer KIND
// per table, the other's envelopes dropped. Split out of `sync-node.ts` so the node's lifecycle
// (start, stop, drain) stays readable in one file.

import { logger } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import { detach } from './detach';
import type { LiveQueryRegistry } from './live-query';
import { RealtimeError } from './realtime-error';
import {
  type ChangeEnvelope,
  type EnvelopeSource,
  parseEnvelope,
  type SeqGapDetector,
} from './replicator-envelope';
import type { BusOutage } from './sync-bus-outage';

export interface SyncBus {
  readonly registry: LiveQueryRegistry;
  readonly hub: ChannelHub;
  readonly gaps: SeqGapDetector;
  readonly producers: ProducerKinds;
  /** The node's outage: a bus that reconnected has answered. */
  readonly outage?: Pick<BusOutage, 'answered'> | undefined;
}

/**
 * The WAL replicator and a `recordPublisher` both carrying one table is every committed row twice
 * on every channel. Logged, never thrown: the bus handler must keep serving every other table.
 */
export class ProducerConflictError extends RealtimeError {
  constructor(args: { table: string; kept: EnvelopeSource; dropped: EnvelopeSource }) {
    super({
      code: 'X_REALTIME_PRODUCER_CONFLICT',
      cause:
        `table "${args.table}" is carried by the ${args.kept} and also by a ${args.dropped}, so ` +
        `every committed row would reach its channels twice; this node keeps the ${args.kept} ` +
        `(seen first) and drops the ${args.dropped}'s changes`,
      // One fix for both orders: the replicator carries every entity table it can see, so the
      // publisher is the half that can let go of one.
      fix: `recordPublisher({ entities: [/* every entity but table ${args.table}'s */] })   # where the replicator runs: it already carries every committed row; then restart the sync node`,
    });
  }
}

/**
 * Which producer kind carries each table, decided by the first envelope this node reads for it and
 * kept for the node's life. The other kind's envelopes for that table are dropped and the conflict
 * said once per table (`X_REALTIME_PRODUCER_CONFLICT`). The `x dev` bridge is no producer here: it
 * delivers in-process and stands in for the replicator, skipping a claimed table itself.
 */
export class ProducerKinds {
  readonly #kinds = new Map<string, EnvelopeSource>();
  readonly #said = new Set<string>();

  /** `true` when this envelope's producer kind is the one its table is carried by. */
  admit(envelope: ChangeEnvelope): boolean {
    const table = envelope.change.table;
    const kind = envelope.source ?? 'replicator';
    const kept = this.#kinds.get(table);
    if (kept === undefined) {
      this.#kinds.set(table, kind);
      return true;
    }
    if (kept === kind) return true;
    if (!this.#said.has(table)) {
      this.#said.add(table);
      const conflict = new ProducerConflictError({ table, kept, dropped: kind });
      // FIELDS, never interpolation, and the message is the CODE alone (`pg-preflight.ts`).
      logger.warn(conflict.code, {
        cause: conflict.cause,
        fix: conflict.fix,
        table,
        kept,
        dropped: kind,
      });
    }
    return false;
  }
}

/** The handler a node subscribes to `CHANGE_SUBJECT_ALL` with. */
export function changeHandler(bus: SyncBus): (payload: string) => void {
  return (payload) => {
    const envelope = parseEnvelope(payload);
    if (!envelope) return;
    // Before the gap detector: a dropped producer's sequence is no stream this node follows.
    if (!bus.producers.admit(envelope)) return;
    // Fanout is at-most-once over core NATS, so a reconnect is changes this node never saw.
    // Nothing downstream could notice: no window's lsn moved, so no cursor moved, so nothing
    // ever asked for a re-snapshot. A gap invalidates every window here instead, and the
    // subscribers are re-served on the next change to each query.
    const replicated = envelope.source !== 'publisher';
    if (bus.gaps.observe(envelope)) {
      // A publisher's lost change was never a window's (below), so only the channels re-read.
      const marked = replicated ? bus.registry.invalidate() : 0;
      // Channels too: their seq is minted from what this node sees, so the hole is invisible
      // to a ring that would otherwise replay across it as complete history.
      const channelGaps = bus.hub.invalidate();
      logger.warn('live.change_gap', {
        table: envelope.change.table,
        desynced: marked,
        channelGaps,
      });
    }
    // Not awaited: the bus handler must return before the next change, and ordering is the
    // registry's — one serial lane per query id. What this call site owes is the failure. An
    // unhandled rejection here is a fanout that reached nobody, reported as a dead process.
    // A publisher's change has no commit position (its lsn orders nothing across processes), and
    // a window refuses a change below its own lsn as stale: fed one, a live query would drop rows
    // silently. Channels mint their own seq, so they take it (`record-publisher.ts`).
    if (replicated) {
      detach(bus.registry.deliver(envelope.change), 'live.deliver', envelope.change.table);
    }
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
    bus.outage?.answered();
    bus.gaps.forget();
    const marked = bus.registry.invalidate();
    const channelGaps = bus.hub.invalidate();
    logger.warn('live.bus_reconnected', { desynced: marked, channelGaps });
  };
}
