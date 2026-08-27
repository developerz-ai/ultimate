// Single responsibility: the six numbers a Postgres pool runs on — the per-role defaults, the one
// environment override an operator may layer over them, and the screen every resolved profile
// passes. Split from `client.ts`, which now owns connecting and nothing about sizing.

import { assert, type Role, resolveRole } from '@ultimat3/core';
import { poolMaxInvalid } from './errors';

export interface PoolProfile {
  readonly max: number;
  /** 0 disables the timeout — only `migrate`, which is allowed to take as long as it takes. */
  readonly statementTimeoutMs: number;
  readonly idleTimeoutMs: number;
  /**
   * How long a statement may **wait for a lock** before `55P03`, distinct from how long it may run.
   * 0 everywhere but `migrate`, which is the only role that takes `ACCESS EXCLUSIVE`: an `alter
   * table` queued behind a long `SELECT` puts every later query on that table behind it too,
   * because Postgres' lock queue is FIFO — and `migrate` runs `statement_timeout = 0`, so nothing
   * else would ever end the wait. Read by `migrate()` as a `SET LOCAL`, never by the pool.
   */
  readonly lockTimeoutMs: number;
  /**
   * How long `reserve()` may wait for a free connection before `X_DB_POOL_EXHAUSTED`. 0 waits
   * forever, which is what a run-once role wants and what a request-serving one must never do:
   * queueing turns exhaustion into a hang, `/readyz`'s `select 1` joins the same queue, the kubelet
   * kills the pod, and the replacement inherits the same saturated database.
   */
  readonly acquireTimeoutMs: number;
  /**
   * How long `close()` may wait for the pool to drain before `X_DB_DRAIN_TIMEOUT`. 0 waits forever.
   *
   * **A drain that cannot finish is the failure this bounds, and it is not hypothetical.** Measured
   * against a real Postgres, three runs per case: `Bun.SQL`'s `end()` waits on an outstanding
   * RESERVED connection and never stops waiting — 3 of 3 on Bun 1.3.14 *and* 3 of 3 on 1.4.0, with
   * no database outage involved at all. Once that connection's backend has been terminated it
   * becomes a race, which 1.3.14 loses 3 of 3 and 1.4.0 loses 1 of 3. So the runtime is not the
   * variable; an unbounded await is (#394).
   *
   * What that cost, before this: `releaseQueue` awaits `db.close()`, so a role whose database went
   * away mid-shutdown never finished shutting down. A container that will not drain is drained by
   * SIGKILL, and the operator's only signal is a pod that took its full termination grace period.
   *
   * `migrate` and `replicator` wait forever, deliberately, for `acquireTimeoutMs`' reason: a
   * run-once role cutting off its own session mid-statement is worse than a slow exit.
   */
  readonly drainTimeoutMs: number;
}

/** Sized per role because the failure modes differ: RPS bursts vs. queue depth vs. run-once. */
export const POOL_PROFILES = Object.freeze<Record<Role, PoolProfile>>({
  web: {
    max: 20,
    statementTimeoutMs: 10_000,
    idleTimeoutMs: 30_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 5_000,
    drainTimeoutMs: 5_000,
  },
  sync: {
    max: 10,
    statementTimeoutMs: 10_000,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 5_000,
    drainTimeoutMs: 5_000,
  },
  worker: {
    max: 8,
    statementTimeoutMs: 120_000,
    idleTimeoutMs: 30_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 10_000,
    drainTimeoutMs: 15_000,
  },
  scheduler: {
    max: 2,
    statementTimeoutMs: 15_000,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 10_000,
    drainTimeoutMs: 5_000,
  },
  // `migrate` waits: its pool is `max: 1` and the advisory-lock pin holds it for the whole run, so
  // a deadline here would refuse the migration's own session. The wait that needed bounding is the
  // advisory lock's, and `MIGRATION_LOCK_WAIT_MS` bounds it.
  migrate: {
    max: 1,
    statementTimeoutMs: 0,
    idleTimeoutMs: 10_000,
    lockTimeoutMs: 3_000,
    acquireTimeoutMs: 0,
    drainTimeoutMs: 0,
  },
  replicator: {
    max: 4,
    statementTimeoutMs: 0,
    idleTimeoutMs: 60_000,
    lockTimeoutMs: 0,
    acquireTimeoutMs: 0,
    drainTimeoutMs: 0,
  },
});

export function poolProfileFor(role: Role = resolveRole()): PoolProfile {
  return POOL_PROFILES[role];
}

/** The one pool knob an operator can turn without a rebuild. Layered over the role default. */
export const POOL_MAX_ENV = 'DATABASE_POOL_MAX';

/**
 * `DATABASE_POOL_MAX`, or nothing. `POOL_PROFILES` is frozen into the build, so before this the
 * only way to change a fleet's connection count was to ship a new image — and 400 `web` pods at
 * `max: 20` is 8,000 backends against a `max_connections` of 450. An unparseable value **refuses**
 * rather than falling back: a fleet that ignored the number it was given is the failure the
 * variable exists to prevent, and it would only be found in `pg_stat_activity` at 3am.
 */
export function poolMaxFromEnv(): Partial<PoolProfile> {
  const raw = process.env[POOL_MAX_ENV];
  if (raw === undefined || raw.trim() === '') return {};
  const max = Number(raw);
  if (!Number.isSafeInteger(max) || max < 1) throw poolMaxInvalid(raw);
  return { max };
}

/**
 * The six numbers a pool runs on, screened on the MERGED profile — an override is spread over a
 * role default the caller never restated, so the resolved object is the only one that can be
 * judged. Every one of them is a plausible `Number(process.env.…)`, which is `NaN` for an unset
 * variable and not nullish, so `??` and the spread both keep it. None of the six then fails
 * loudly: `idleTimeout: NaN` goes to `Bun.SQL`, `statement_timeout=NaN` goes into the libpq
 * options string for the SERVER to reject on connect, and a timer given `NaN` fires at 1ms in this
 * Bun — so a pool with free connections reports itself exhausted. `0` stays legal for the five
 * budgets that document it as "no bound"; `max` is at least one connection, or nothing can run.
 */
export function assertPoolProfile(profile: PoolProfile): PoolProfile {
  const whole = (option: string, value: number, min: 0 | 1): void => {
    assert(
      Number.isSafeInteger(value) && value >= min,
      `pool profile ${option} is ${String(value)}; it must be a whole number of ${min === 1 ? 'at least 1' : '0 or more, where 0 is the documented "no bound"'}`,
      `pass a whole number for ${option} in createPostgresClient({ profile }), and parse an environment value first — Number(process.env.DATABASE_${option.toUpperCase()} ?? '') is NaN when the variable is unset`,
    );
  };
  whole('max', profile.max, 1);
  whole('statementTimeoutMs', profile.statementTimeoutMs, 0);
  whole('idleTimeoutMs', profile.idleTimeoutMs, 0);
  whole('lockTimeoutMs', profile.lockTimeoutMs, 0);
  whole('acquireTimeoutMs', profile.acquireTimeoutMs, 0);
  whole('drainTimeoutMs', profile.drainTimeoutMs, 0);
  return profile;
}
