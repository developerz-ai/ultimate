// Sequence accounting for the forced-restart benchmark: holes in the probe stream, per connection,
// and whether each one was REPAIRED. Its own file so the arithmetic that decides "this frame was
// lost" is testable without a socket. Since 21.0.0 a dropped channel `records` frame is marked by
// the node and answered with `replay-gap` (the client re-reads), so a hole is loss only when no
// `replay-gap` followed it — `unrepaired`, which a run must hold at zero.

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
  /** `replay-gap` frames received: each one repairs every hole this client is still holding. */
  replayGaps: number;
  /** Missing frames a later `replay-gap` repaired. */
  repaired: number;
  /** Missing frames no `replay-gap` has answered YET. At the end of a run, these are the loss. */
  pending: number;
  /**
   * A `replay-gap` arrived since the last frame. The node sends it BEFORE the next frame, so the
   * hole that frame reveals is one the re-read already covered — it is repaired, never pending.
   */
  covering: boolean;
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
    replayGaps: 0,
    repaired: 0,
    pending: 0,
    covering: false,
    duplicates: 0,
    rewinds: 0,
    malformed: 0,
    lastSeq: null,
  };
}

/**
 * A `replay-gap` arrived: the client re-reads the channel's catch-up query, so every hole it holds
 * is repaired — including one left on a connection that has since closed, because the re-read is
 * of the channel, not of the connection.
 */
export function recordReplayGap(counters: SeqCounters): void {
  counters.replayGaps += 1;
  counters.repaired += counters.pending;
  counters.pending = 0;
  counters.covering = true;
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
  const covered = counters.covering;
  counters.covering = false;
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
    if (covered) counters.repaired += skipped;
    else counters.pending += skipped;
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
  readonly replayGaps: number;
  readonly repaired: number;
  /** Missing frames no `replay-gap` ever answered. THE number: a run is clean only at zero. */
  readonly unrepaired: number;
  /** Observers still holding an unrepaired hole at the end of the run. */
  readonly clientsUnrepaired: number;
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
    replayGaps: 0,
    repaired: 0,
    unrepaired: 0,
    clientsUnrepaired: 0,
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
    summary.replayGaps += counters.replayGaps;
    summary.repaired += counters.repaired;
    summary.unrepaired += counters.pending;
    if (counters.pending > 0) summary.clientsUnrepaired += 1;
    summary.duplicates += counters.duplicates;
    summary.rewinds += counters.rewinds;
    summary.malformed += counters.malformed;
  }
  return summary;
}

/**
 * The run's verdict, as a list rather than a boolean so a failing run names what it lost. Empty is
 * the bar: every hole a client saw was answered by a `replay-gap`. `missing` alone is no longer a
 * failure — a hole the node repaired is the design working, not loss.
 */
export function unrepairedFindings(summary: SeqSummary): readonly string[] {
  if (summary.unrepaired === 0) return [];
  return [
    `${summary.unrepaired} channel frame(s) lost on ${summary.clientsUnrepaired} client(s) with no ` +
      `replay-gap after them — the node dropped a records frame and never told the client to re-read`,
  ];
}
