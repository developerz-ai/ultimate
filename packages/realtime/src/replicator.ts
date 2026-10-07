// The `replicator` role: consume the change feed, normalize, publish to the transport. Nothing else.
//
// **Exactly one per database.** Two replicators on one slot means every change is fanned out twice:
// duplicate patches, duplicate lsns, and a client digest that can never converge. The invariant is
// enforced by a Postgres session-level advisory lock, not by deployment discipline:
//
//   SELECT pg_try_advisory_lock(hashtext('x:replicator:<slot>'))
//
// The lock is tied to the *session*, so a crashed replicator releases it automatically — no lease
// renewal, no fencing token, no split brain. A process that fails to take the lock does not start
// its feed and reports `/readyz` false. A stream that ENDS — or a lock that is LOST — is this file's
// to answer: `running` goes false, everything is let go, and the process asks again on a backoff.

import { logger, renderThrowable, uuidV7, withSpan } from '@ultimat3/core';
import type { AdvisoryLock } from './advisory-lock';
import type { ChangeEvent, ChangeFeed } from './changefeed';
import { ReplicationFailedError } from './errors';
import type { Transport } from './fanout';
import { encodeEnvelope } from './replicator-envelope';
import {
  type BackoffPolicy,
  defaultBackoff,
  policyDelay,
  type Rng,
  type Scheduler,
} from './thundering-herd';

export const CHANGE_SUBJECT_PREFIX = 'x.change';

/** Every change subject: what a `sync` node subscribes to. A changefeed subject, never a channel. */
export const CHANGE_SUBJECT_ALL = `${CHANGE_SUBJECT_PREFIX}.>`;

/** `x.change.<table>.<orgId>` — tenant in the subject, so fanout filters without parsing a row. */
export function changeSubject(change: ChangeEvent): string {
  return `${CHANGE_SUBJECT_PREFIX}.${change.table}.${change.orgId ?? '_'}`;
}

export interface ReplicatorOptions {
  readonly feed: ChangeFeed;
  readonly transport: Transport;
  readonly lock: AdvisoryLock;
  /** Resume position, normally the last lsn this replicator persisted. */
  readonly from?: string;
  readonly subjectOf?: (change: ChangeEvent) => string;
  readonly backoff?: BackoffPolicy;
  readonly rng?: Rng;
  /** The timer a restart waits on. Injected so a test proves the takeover loop without sleeping. */
  readonly schedule?: Scheduler;
}

export interface ReplicatorStats {
  readonly published: number;
  readonly skipped: number;
  readonly outOfOrder: number;
  /** Streams this replicator brought back after one ended on its own. */
  readonly restarts: number;
  /**
   * Why this replicator is not running although nothing stopped it — the stream's own reason, the
   * last restart's, or the change (table, lsn, how many times) the bus keeps refusing. `null`
   * while it runs, and after a `stop()`.
   */
  readonly failure: string | null;
}

export interface Replicator {
  /** `false` = another replicator holds the lock; this process must stay `/readyz` false. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
  /**
   * `true` only while this process is REPLICATING: a stream is pumping under the lock, and no
   * change is waiting on a publish the bus keeps refusing. `false` the moment the stream ends or
   * the lock is lost, and through every restart that has yet to publish the change it owes — the
   * one fact a readiness check has to read.
   */
  readonly running: boolean;
  lastLsn(): string | null;
  stats(): ReplicatorStats;
  /** Delay before the next takeover attempt, jittered so N standbys do not collide. */
  retryDelayMs(attempt: number): number;
}

/** One `begin()`: the stream and the lock grant that belong together. */
interface Run {
  /** Why this run is over — the stream ended, the lock was lost, or it was stopped. */
  over: string | null;
}

/** The change a run could not publish, kept until one goes out. */
interface Refusal {
  readonly table: string;
  readonly lsn: string;
  readonly error: string;
  times: number;
}

/**
 * How long each polite goodbye of a `stop()` may take — the feed's, then the lock's — before the
 * thing is abandoned instead. Both are conversations with a socket; a black-holed one never
 * answers, and a SIGTERM that waited on it never finished.
 */
export const STOP_DEADLINE_MS = 5_000;

const fencedOut = (reason: string): ReplicationFailedError =>
  new ReplicationFailedError({
    stage: 'stream',
    detail: `a change arrived for a run that is over (${reason}), and was not published`,
    fix: 'x doctor --json',
  });

export function changeFeedReplicator(options: ReplicatorOptions): Replicator {
  const subjectOf = options.subjectOf ?? changeSubject;
  const backoff = options.backoff ?? defaultBackoff;
  /** A stream is pumping under a lock this process holds. Internal: `running` is stricter. */
  let pumping = false;
  let lastLsn: string | null = null;
  let published = 0;
  let skipped = 0;
  let outOfOrder = 0;
  // One id per run, not per process: a replicator that took the lock back after a crash publishes
  // from its persisted lsn, and a consumer must read that as a new stream rather than as a gap in
  // the old one.
  let producer = uuidV7();
  let seq = 0;
  /** The start in flight, if any — see `start()` on why `pumping` cannot answer that question. */
  let starting: Promise<boolean> | undefined;
  const schedule = options.schedule ?? unrefScheduler;
  let restarts = 0;
  let failure: string | null = null;
  /** Set by `stop()`: the one thing that ends the takeover loop. */
  let stopped = false;
  /** The run whose stream and lock still speak for this replicator. */
  let current: Run | undefined;
  let cancelRetry: (() => void) | undefined;
  /** Stops listening for the lock being lost. Held only while this replicator holds the lock. */
  let unwatchLock: (() => void) | undefined;
  const unwatch = (): void => {
    unwatchLock?.();
    unwatchLock = undefined;
  };
  /**
   * Deaths since a change was last PUBLISHED. "The stream started" is not progress: a change the
   * bus refuses every time kills each new stream on its first delivery, and counting from the
   * start made that a redial — two dials, a preflight, a `START_REPLICATION` — at the base delay
   * forever, with the WAL retained behind it.
   */
  let attempt = 0;
  let refusal: Refusal | null = null;

  /** One goodbye against the deadline, on the `schedule` seam. Never rejects. */
  const bounded = async (
    goodbye: Promise<void>,
  ): Promise<
    { readonly how: 'done' | 'late' } | { readonly how: 'failed'; readonly error: unknown }
  > => {
    let cancel = (): void => undefined;
    const deadline = new Promise<{ readonly how: 'late' }>((resolve) => {
      cancel = schedule(() => resolve({ how: 'late' }), STOP_DEADLINE_MS);
    });
    const said = goodbye.then(
      () => ({ how: 'done' as const }),
      (error: unknown) => ({ how: 'failed' as const, error }),
    );
    const outcome = await Promise.race([said, deadline]);
    cancel();
    return outcome;
  };

  /**
   * The orderly unlock, bounded. Past the deadline — or refused — the session is dropped instead:
   * closing it releases the lock just the same.
   */
  const release = async (): Promise<void> => {
    if ((await bounded(options.lock.release())).how !== 'done') options.lock.abandon();
  };

  /** The orderly stream stop, bounded the same way. A refusal is handed back for the caller. */
  const quiet = async (): Promise<unknown> => {
    const outcome = await bounded(options.feed.stop());
    if (outcome.how !== 'done') options.feed.abandon();
    return outcome.how === 'failed' ? outcome.error : undefined;
  };

  const changeHandler =
    (run: Run) =>
    async (raw: ChangeEvent): Promise<void> => {
      // Fenced by run, and REFUSED rather than dropped: after a lock loss the socket still holds
      // changes, and publishing them is one of two replicators speaking. A handler that merely
      // returned would let the stream count the change delivered and confirm it.
      if (current !== run || run.over !== null) throw fencedOut(run.over ?? 'a newer run started');
      const change = normalize(raw);
      if (!change) {
        skipped += 1;
        return;
      }
      if (lastLsn !== null && change.lsn <= lastLsn) {
        // At-least-once delivery is the feed's contract, so a repeat is expected, not an error.
        outOfOrder += 1;
        return;
      }
      await withSpan('realtime.replicate', async () => {
        seq += 1;
        try {
          await options.transport.publish(subjectOf(change), encodeEnvelope(change, seq, producer));
        } catch (thrown) {
          const error = renderThrowable(thrown);
          const same = refusal !== null && refusal.lsn === change.lsn;
          refusal = {
            table: change.table,
            lsn: change.lsn,
            error,
            times: same ? (refusal?.times ?? 0) + 1 : 1,
          };
          throw thrown;
        }
        lastLsn = change.lsn;
        published += 1;
        // Progress: the next death waits the base delay again, and nothing is owed any more.
        attempt = 0;
        if (refusal !== null) {
          refusal = null;
          if (pumping) failure = null;
        }
      });
    };

  /** What `stats().failure` says while a change keeps being refused: which one, and how often. */
  const describeFailure = (reason: string): string =>
    refusal === null
      ? reason
      : `${refusal.table} at lsn ${refusal.lsn} could not be published ` +
        `(${refusal.times} time(s) in a row): ${refusal.error}`;

  const begin = async (): Promise<boolean> => {
    if (!(await options.lock.tryAcquire())) {
      logger.warn('replicator standby: advisory lock held elsewhere', { key: options.lock.key });
      return false;
    }
    producer = uuidV7();
    seq = 0;
    const run: Run = { over: null };
    current = run;
    const end = (reason: string): void => {
      if (run.over !== null) return;
      run.over = reason;
      // Not yet `pumping`: `begin` is still between the feed's start and its own last line, and
      // reads `run.over` there. Not `current`: a stop or a newer run owns the replicator now.
      if (current === run && pumping) lost(reason);
    };
    // The lock is a session, and a session can die while the stream stays up — or while it is
    // still being dialled. Postgres then gives the lock to whoever asks next, and the loss is said
    // ONCE: recorded on the run, so a start that was mid-dial reads it below instead of going on
    // to stream, ready and unlocked, for the rest of the process's life.
    unwatch();
    unwatchLock = options.lock.onLost((reason) => end(`the advisory lock was lost: ${reason}`));
    // A restart resumes where THIS process got to. `options.from` is where the first run began;
    // handing it to the second would have the feed re-deliver everything published since.
    const from = lastLsn ?? options.from;
    const onChange = changeHandler(run);
    let fed = false;
    try {
      await options.feed.start(
        from === undefined ? { onChange, onEnd: end } : { from, onChange, onEnd: end },
      );
      fed = true;
      if (run.over !== null) {
        throw new ReplicationFailedError({
          stage: 'stream',
          detail: `the run was over as it started: ${run.over}`,
          fix: 'x doctor --json',
        });
      }
    } catch (thrown) {
      // A start that failed holds NOTHING. `pumping` stays false so the takeover loop's next
      // `start()` runs `begin` again instead of being answered `true` by a memo over a feed that
      // never pumped, and the lock goes back so a standby can take the slot rather than waiting on
      // a holder that is not replicating. A feed that DID start — the lock went while it dialled —
      // is stopped first: it must not outlive the grant it was started under.
      run.over ??= renderThrowable(thrown);
      unwatch();
      if (fed) await quiet();
      await release();
      throw thrown;
    }
    // AFTER the feed is pumping, never before: `pumping` is what `start()` answers `true` from and
    // what `stop()` reads to decide there is anything to tear down.
    pumping = true;
    if (refusal === null) failure = null;
    logger.info('replicator started', { source: options.feed.source, key: options.lock.key });
    return true;
  };

  /** Memoised — see `start()`. The takeover loop calls this, never `start()`: it must not un-stop. */
  const launch = (): Promise<boolean> => {
    if (pumping) return Promise.resolve(true);
    const inFlight = starting;
    if (inFlight !== undefined) return inFlight;
    // Cleared however it settles: a `false` is "another node holds the lock", and the takeover
    // loop asks again a `retryDelayMs` later. A memo that stuck would make this node a permanent
    // standby of a slot whose holder has already died.
    const begun = begin().finally(() => {
      if (starting === begun) starting = undefined;
    });
    starting = begun;
    return begun;
  };

  const retryDelayMs = (count: number): number =>
    // This method's contract is 0-based (`retryDelayMs(0)` is the base); core counts from 1.
    policyDelay(backoff, count + 1, options.rng ?? Math.random);

  /**
   * The takeover loop. One timer at a time, each on a longer delay than the last until a change
   * is PUBLISHED — which is what resets the count (`changeHandler`), not a stream coming up.
   * `false` from `launch` is another process holding the lock, which is this loop working: that
   * process replicates, and this one keeps asking in case it dies too.
   */
  const retry = (): void => {
    if (stopped) return;
    const wait = retryDelayMs(attempt);
    attempt += 1;
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      // `pumping` already: the owner called `start()` itself while this timer was armed.
      if (stopped || pumping) return;
      // Voided: both outcomes are handled right here, and a timer has nobody to hand a promise to.
      void launch().then(
        (started) => {
          if (started) restarts += 1;
          else retry();
        },
        (thrown: unknown) => {
          failure = describeFailure(renderThrowable(thrown));
          logger.warn('replicator.restart_failed', { key: options.lock.key, error: failure });
          retry();
        },
      );
    }, wait);
  };

  /**
   * A stream that ended on its own, or a lock that was lost. It used to be recorded where nothing
   * read it: `running` stayed `true`, the lock stayed held, and the fleet's live windows froze
   * until the pod was restarted. Everything the run held is let go here and the loop above asks
   * for it back.
   *
   * Both are ABANDONED, never asked, and synchronously: a black-holed socket is what produces a
   * lost stream, and a goodbye to one — the feed's or the lock's — is a recovery that never
   * reaches its retry. Being synchronous is also what leaves no window for a `start()` to be
   * answered over a run still being torn down.
   */
  const lost = (reason: string): void => {
    pumping = false;
    failure = describeFailure(reason);
    unwatch();
    logger.error('replicator.stream_ended', { key: options.lock.key, error: failure });
    // The feed first: it must be silent before the grant it ran under is given up. Anything its
    // socket still held is refused by the run's own fence.
    options.feed.abandon();
    options.lock.abandon();
    retry();
  };

  return {
    /**
     * Deliberately NOT `async`: `pumping` is set after an `await` on the lock, so a guard that
     * awaited anything before registering has the same hole it is meant to close. Two overlapping
     * starts both passed the guard, both were told they held the lock — a holder's
     * `tryAcquire()` answers `true` — and both ran `feed.start()`: one replication slot with two
     * pumps, publishing every change twice under two `seq` generations of one producer id, which
     * every sync node's `SeqGapDetector` reads as a gap and repairs by re-snapshotting the fleet.
     * Same shape as `packages/core/src/lifecycle.ts`'s `drain()`.
     */
    start(): Promise<boolean> {
      stopped = false;
      return launch();
    },

    async stop(): Promise<void> {
      // A stop racing a start waits it out: `pumping` is false for the whole of `begin`, so the
      // early return below would leave the feed it is about to start pumping into a replicator
      // nothing intends to stop, with the advisory lock still held.
      stopped = true;
      cancelRetry?.();
      cancelRetry = undefined;
      const inFlight = starting;
      if (inFlight !== undefined) await inFlight.catch(() => false);
      // An orderly stop is not a failure, whatever the last stream died of.
      failure = null;
      refusal = null;
      if (!pumping) return;
      pumping = false;
      if (current !== undefined) current.over ??= 'the replicator was stopped';
      current = undefined;
      unwatch();
      // Whatever the feed said: a lock kept because the stream would not close politely is a
      // slot no standby can take. Its refusal is still the one the caller is owed.
      const refused = await quiet();
      await release();
      if (refused !== undefined) throw refused;
    },

    get running(): boolean {
      // Replicating, not merely connected: a stream that is up while the change it owes is still
      // being refused has published nothing, and must not read as ready between two of its deaths.
      return pumping && refusal === null;
    },

    lastLsn(): string | null {
      return lastLsn ?? options.feed.lastLsn();
    },

    stats(): ReplicatorStats {
      return { published, skipped, outOfOrder, restarts, failure };
    },

    retryDelayMs,
  };
}

/** The production timer: a pending restart must never be what keeps a draining process alive. */
const unrefScheduler: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return () => {
    clearTimeout(handle);
  };
};

/** Drops events the pipeline cannot use and hoists the tenant id out of the row. */
export function normalize(change: ChangeEvent): ChangeEvent | null {
  // The one change that carries no row by design; nothing to hoist a tenant out of.
  if (change.op === 'truncate') return change;
  const row = change.after ?? change.before;
  if (!row) return null;
  if (change.op === 'insert' && change.after === null) return null;
  if (change.op === 'delete' && change.before === null) return null;
  if (change.orgId !== null) return change;
  const orgId = row['orgId'];
  return typeof orgId === 'string' ? { ...change, orgId } : change;
}
