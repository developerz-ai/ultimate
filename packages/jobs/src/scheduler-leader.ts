// Who dispatches: the election a scheduler asks, and the single-node answer. Split off
// `scheduler.ts` at the file-size ceiling; the lease-backed election is `scheduler-pg.ts`'s.

export interface LeaderElection {
  acquire(): Promise<boolean>;
  release(): Promise<void>;
  /**
   * How long a grant may be relied on before `acquire()` is asked again, in ms. `0` asks before
   * every dispatch. A lease-backed election states a fraction of its TTL: the row cannot change
   * hands inside it, so asking sooner is a write that decides nothing — it was one per task per
   * second. What makes relying on it SAFE is not this number: an occurrence fires in one statement
   * fenced on the watermark (`SchedulerState.fire`), so two nodes that both believe they lead
   * still queue it once.
   */
  readonly renewEveryMs: number;
}

/** Single-node default: always the leader. Multi-node uses `createPgLeaseLeader()` — never
 * `createPgLeader()`, whose advisory lock is owned by a pooled session this process cannot name. */
export function soleLeader(): LeaderElection {
  return {
    acquire: () => Promise.resolve(true),
    release: () => Promise.resolve(),
    renewEveryMs: 0,
  };
}
