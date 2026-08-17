// Sequence accounting for the forced-restart benchmark: how many probe messages a client was sent
// versus how many it received, per connection. Separate from the client so the arithmetic that
// decides "this frame was lost" can be tested without a socket, and so the orchestrator can sum it.
//
// Why it exists: a channel topic has no cursor and no re-snapshot, so a patch dropped by
// backpressure (`SyncSocket.send` returns false; `SocketRegistry.deliver` and `ChannelHub`'s bridge
// both discard that answer) is gone for good. A first-delivery timer cannot see one.

/**
 * One client's accounting, summed across every connection it holds. Plain JSON on purpose: it
 * crosses the shard-process boundary inside `ClientStats`.
 */
export interface SeqCounters {
  /** Connection epochs that saw at least one probe message. */
  epochs: number;
  /** Probe messages received, malformed ones excluded. */
  received: number;
  /**
   * Probe messages the publisher assigned that this client never got **while demonstrably
   * subscribed** — a hole between two messages it did receive on one connection. A LOWER BOUND:
   * anything lost before the first or after the last message of a connection is invisible here.
   */
  missing: number;
  /** Discontinuities, however wide. `missing` is the frame count; this is the event count. */
  gapEvents: number;
  duplicates: number;
  /**
   * Times the value went BACKWARDS inside one connection — a publisher whose counter restarted,
   * never a loss. Kept apart from `missing` because that distinction is the whole metric: the bench
   * server's probe counter resets to zero on every fresh process, so a counter that read a restart
   * as a gap would report the restart it exists to measure as ~one lost frame per publish.
   */
  rewinds: number;
  /** Values that were not an integer. Counted rather than dropped: a silent skip is the bug. */
  malformed: number;
  /** Live anchor for the current epoch. Not a result — `beginSeqEpoch` clears it. */
  lastSeq: number | null;
}

export function newSeqCounters(): SeqCounters {
  return {
    epochs: 0,
    received: 0,
    missing: 0,
    gapEvents: 0,
    duplicates: 0,
    rewinds: 0,
    malformed: 0,
    lastSeq: null,
  };
}

/**
 * A new connection: forget the anchor. Every message published while this client was disconnected
 * is legitimately absent, so the next value received starts a fresh run rather than measuring a
 * hole back to the previous connection's last one.
 */
export function beginSeqEpoch(counters: SeqCounters): void {
  counters.lastSeq = null;
}

/**
 * Folds one received probe value in. Returns the parsed sequence number, or `null` if the value was
 * not one — the caller's single parse, so nothing downstream re-reads the wire.
 *
 * Takes `unknown` because `seq` is a `JsonValue` off a decoded frame: the wire shape is a claim
 * about the publisher, not a guarantee about the bytes.
 */
export function recordSeq(counters: SeqCounters, seq: unknown): number | null {
  if (typeof seq !== 'number' || !Number.isInteger(seq)) {
    counters.malformed += 1;
    return null;
  }
  const previous = counters.lastSeq;
  counters.received += 1;
  counters.lastSeq = seq;
  if (previous === null) {
    counters.epochs += 1;
    return seq;
  }
  if (seq === previous) {
    counters.duplicates += 1;
    return seq;
  }
  if (seq < previous) {
    counters.rewinds += 1;
    return seq;
  }
  const skipped = seq - previous - 1;
  if (skipped > 0) {
    counters.missing += skipped;
    counters.gapEvents += 1;
  }
  return seq;
}

/** The swarm's accounting, as it lands in the report and in `scripts/bench/results/`. */
export interface SeqSummary {
  /** Clients that received at least one probe message. A client that received none counts nothing. */
  readonly observers: number;
  /** Observers that lost at least one message between two they received. The headline number. */
  readonly clientsWithGaps: number;
  readonly epochs: number;
  readonly received: number;
  readonly missing: number;
  readonly gapEvents: number;
  readonly duplicates: number;
  readonly rewinds: number;
  readonly malformed: number;
}

export function summarizeSeq(all: readonly SeqCounters[]): SeqSummary {
  const summary = {
    observers: 0,
    clientsWithGaps: 0,
    epochs: 0,
    received: 0,
    missing: 0,
    gapEvents: 0,
    duplicates: 0,
    rewinds: 0,
    malformed: 0,
  };
  for (const counters of all) {
    if (counters.received > 0) summary.observers += 1;
    if (counters.missing > 0) summary.clientsWithGaps += 1;
    summary.epochs += counters.epochs;
    summary.received += counters.received;
    summary.missing += counters.missing;
    summary.gapEvents += counters.gapEvents;
    summary.duplicates += counters.duplicates;
    summary.rewinds += counters.rewinds;
    summary.malformed += counters.malformed;
  }
  return summary;
}
