// Single responsibility: the production `AdvisoryLock` — backs `replicator.ts`'s "exactly one
// replicator per database" invariant with `SELECT pg_try_advisory_lock(hashtext(key))`. The lock
// is scoped to this connection's Postgres *session*, so acquiring means keeping the connection
// open and releasing means closing it: no lease, no renewal, no fencing token, ever.

import { ReplicationFailedError } from './errors';
import { PgConnection, type PgRows } from './pg-connection';
import { bunPgStream, type PgTarget, parsePgUrl } from './pg-socket';
import type { PgStream } from './pg-wire';
import type { AdvisoryLock } from './replicator';
import type { Rng } from './thundering-herd';

/** A key reaches a simple query unparameterised, so its charset is the injection boundary. */
const KEY_PATTERN = /^[A-Za-z0-9:_.-]+$/;

export interface PgAdvisoryLockOptions {
  /** Connection string for the database whose replicator this is. */
  readonly url: string;
  /** Lock identity, e.g. `x:replicator:<slot>`. Hashed by Postgres, not by us. */
  readonly key: string;
  /** The byte pipe, injected. Defaults to `bunPgStream`; a test drives a scripted server. */
  readonly stream?: ((target: PgTarget) => Promise<PgStream>) | undefined;
  /** Injected so the SCRAM nonce is deterministic under a seeded test. */
  readonly rng?: Rng | undefined;
}

/**
 * One `pg_try_advisory_lock`, held by a connection this class opens for itself. Postgres refcounts
 * a session-level advisory lock per acquisition — a second `pg_try_advisory_lock` on a session that
 * already holds the key would need a matching second `pg_advisory_unlock`, and `release()` only
 * ever issues one, so taking a second grant here would be a leak, not a no-op.
 */
export class PgAdvisoryLock implements AdvisoryLock {
  readonly key: string;
  readonly #options: PgAdvisoryLockOptions;
  #connection: PgConnection | null = null;
  /**
   * The acquisition in flight, if any. `#connection` cannot answer "am I already taking this" —
   * it is written at the END of an acquisition, with a dial, a handshake and a query awaited in
   * between, so two concurrent callers both read `null` and both opened a session. Both then took
   * a grant on the same key (a second `pg_try_advisory_lock` on a DIFFERENT session succeeds only
   * if the first has not landed yet, and on the same key from two sessions one of them answers
   * `f` — either way the loser's session was left open), and the second assignment to
   * `#connection` orphaned the first: `release()` closes one, and the other holds the lock until
   * the process dies. A standby then never takes over a slot whose owner has already stopped.
   */
  #acquiring: Promise<boolean> | null = null;

  constructor(options: PgAdvisoryLockOptions) {
    if (!KEY_PATTERN.test(options.key)) {
      throw new ReplicationFailedError({
        stage: 'preflight',
        detail: `advisory lock key "${options.key}" is not [A-Za-z0-9:_.-]+`,
        fix:
          'rename the lock key to match [A-Za-z0-9:_.-]+ — it is interpolated into ' +
          'pg_try_advisory_lock(hashtext(...))',
      });
    }
    this.key = options.key;
    this.#options = options;
  }

  /**
   * Deliberately NOT `async`: the guard and the registration have to be one synchronous step, or
   * the memo has the same check-then-act hole as the field it replaces. Same shape as
   * `packages/core/src/lifecycle.ts`'s `drain()` and `packages/jobs/src/worker.ts`'s `round()`.
   */
  tryAcquire(): Promise<boolean> {
    // Already ours — see the class comment on why a second `pg_try_advisory_lock` must not run.
    if (this.#connection !== null) return Promise.resolve(true);
    const inFlight = this.#acquiring;
    if (inFlight !== null) return inFlight;
    // Cleared however it settles: a `false` is "somebody else holds it right now", which the
    // replicator's takeover loop asks again a backoff later, and a rejection is the database
    // refusing THIS attempt. A memo either of those stuck to would answer for the process's life.
    const attempt = this.#acquire().finally(() => {
      if (this.#acquiring === attempt) this.#acquiring = null;
    });
    this.#acquiring = attempt;
    return attempt;
  }

  async #acquire(): Promise<boolean> {
    const target = parsePgUrl(this.#options.url);
    const stream = await (this.#options.stream ?? bunPgStream)(target);
    // Plain SQL, not `replication: 'database'` — this session runs one statement, never a feed.
    const connection = await PgConnection.open({
      stream,
      user: target.user,
      password: target.password,
      database: target.database,
      applicationName: `ultimate-replicator-lock:${this.key}`,
      rng: this.#options.rng,
    });
    let rows: PgRows;
    try {
      rows = await connection.query(`SELECT pg_try_advisory_lock(hashtext('${this.key}'))`);
    } catch (failure) {
      // "The database refused me" and "another process holds it" are different facts; only the
      // second is a `false`, so a query failure closes what was opened and propagates instead.
      await connection.close();
      throw failure;
    }
    if (rows[0]?.[0] !== 't') {
      // A standby must not hold an idle session for a lock it did not get.
      await connection.close();
      return false;
    }
    // Kept open on purpose: this session *is* the lock, and closing it is the whole of
    // `release()` — which is exactly what lets a crashed replicator free the slot with nothing
    // left to clean up.
    this.#connection = connection;
    return true;
  }

  async release(): Promise<void> {
    // A release that arrives mid-acquisition waits it out. `#connection` is still `null` there, so
    // the early return below would answer "nothing to release" and the session would open behind
    // it, holding the key with no object left intending to close it — the same orphan the memo
    // exists to prevent, reached from the other side. The attempt's own failure is not this
    // caller's to report: `tryAcquire`'s caller already has it.
    const acquiring = this.#acquiring;
    if (acquiring !== null) await acquiring.catch(() => false);
    const connection = this.#connection;
    if (connection === null) return;
    this.#connection = null;
    try {
      await connection.query(`SELECT pg_advisory_unlock(hashtext('${this.key}'))`);
    } finally {
      // The close releases the session lock regardless, so it must run even if the unlock did not.
      await connection.close();
    }
  }
}
