// Single responsibility: decide, once per status interval, whether a replication stream's far end
// is still there — the read deadline and the confirm deadline. Counted in INTERVALS rather than on
// a clock: the feed's clock is injected (and frozen under test), the interval timer is not, and a
// deadline that is a multiple of the interval cannot disagree with the interval it is built on.

/**
 * Intervals a stream may go without a byte from the walsender while the pump waits on a read, and
 * intervals one standby status update may stay unsettled, before either is a death.
 *
 * Three, at the default 10 s interval, is 30–40 s — inside postgres' own 60 s `wal_sender_timeout`,
 * the same bound `MAX_CONFIRM_FAILURES` sets for writes that reject. Every timer confirm asks for a
 * reply (`replyRequested = 1`), so a live walsender is never silent for a whole interval.
 */
export const MAX_SILENT_INTERVALS = 3;

/** A confirm on the wire: the identity the interval that sent it holds, and what it settles. */
export type ConfirmAttempt = symbol;

export class StreamLiveness {
  #silent = 0;
  #reading = false;
  #inFlight: ConfirmAttempt | null = null;

  /** A new run: the last run's silence and its parked confirm are not this one's. */
  reset(): void {
    this.#silent = 0;
    this.#reading = false;
    this.#inFlight = null;
  }

  /** The pump is parked on the socket. Silence is measured only from here. */
  awaitingRead(): void {
    this.#reading = true;
  }

  /**
   * The read returned. A pump busy inside `onChange` is not reading, so a slow consumer is never
   * mistaken for a dead walsender: its bytes are in the socket buffer, not missing.
   */
  heard(): void {
    this.#reading = false;
    this.#silent = 0;
  }

  /**
   * One interval elapsed. `true` once `MAX_SILENT_INTERVALS` of them passed with the pump waiting
   * and nothing arriving. Decided BEFORE this interval is counted, so the interval that sends the
   * reply request is given the whole of the next one to be answered.
   */
  silentTooLong(): boolean {
    if (this.#silent >= MAX_SILENT_INTERVALS) return true;
    if (this.#reading) this.#silent += 1;
    return false;
  }

  /**
   * An identity for the confirm this interval sends, or `null` when the last one has not settled. A
   * write parked on a `drain` that never fires is never a rejection, so "still in flight at the
   * next interval" is the only way it is ever seen — and nothing more is queued behind it.
   */
  begin(): ConfirmAttempt | null {
    if (this.#inFlight !== null) return null;
    this.#inFlight = Symbol('confirm');
    return this.#inFlight;
  }

  /** Settled, either way. One from a run `reset()` has since replaced changes nothing. */
  settle(attempt: ConfirmAttempt): void {
    if (this.#inFlight === attempt) this.#inFlight = null;
  }
}

/** The death of a stream nobody answered: what was measured, and what happens next. */
export const silenceReason = (intervalMs: number): string =>
  `nothing from the walsender for ${MAX_SILENT_INTERVALS} status intervals ` +
  `(${MAX_SILENT_INTERVALS * intervalMs} ms) though every one asked for a reply — the connection ` +
  'is half-open (a failover that moved the address, a NAT drop, a partition); the stream is ' +
  'dropped without a goodbye so the replicator redials';

/** The death of a stream whose standby status update never settled. */
export const unsettledReason = (intervals: number, intervalMs: number): string =>
  `a standby status update has not settled for ${intervals} status intervals ` +
  `(${intervals * intervalMs} ms) — the socket accepts no writes; the stream is dropped without ` +
  'a goodbye so the replicator redials';
