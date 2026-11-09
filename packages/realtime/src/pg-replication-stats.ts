// Single responsibility: the shape of what a replication stream reports about itself — what
// `changefeed.ts` surfaces as `stats()` and `/readyz` reads. Counts and the death reason only.

export interface ReplicationStreamStats {
  readonly delivered: number;
  /** Rows for a table outside the entity list — the publication is wider than the app is. */
  readonly skipped: number;
  /** Rows replayed from before the resume position, dropped so `onChange` sees each one once. */
  readonly replayed: number;
  /**
   * Changes delivered from a relation whose replica identity is not FULL — so the `before` row is
   * the key columns alone (or absent), and the live matcher's "did this row leave the result set"
   * is decided on a partial row. `X_LIVE_REPLICA_IDENTITY` warns about the CONFIGURATION once at
   * preflight; this counts the decisions it actually cost, which is the half a running node can
   * be alerted on. Inserts never count: there is no `before` to be partial.
   */
  readonly partialBefore: number;
  /**
   * Standby-status writes that have failed in a row without one landing in between. It is the half
   * of a broken stream the delivery count cannot show: the read side goes on delivering while
   * `confirmed_flush_lsn` stops advancing, so WAL accumulates on the primary with nothing else
   * reporting it. An interval whose update is still unsettled from the last one counts too: a
   * write parked on a socket that never drains is never a rejection. Reset by the first that lands.
   */
  readonly confirmFailures: number;
  /** Why the pump stopped, or `null` while live. Recorded here and ANNOUNCED through `onEnd`. */
  readonly failure: string | null;
}
