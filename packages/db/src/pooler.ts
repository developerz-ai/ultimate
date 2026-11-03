// Single responsibility: a connection pooler in the path — the mode the environment names, how long
// a statement may queue in it, the two bounds as the session reads them, and the two errors a pooler
// in the path is reported with. The fix text is `pooler-fix.ts`', which `errors.ts` reads too.

import { describeValue, finiteCount } from '@ultimat3/core';
import type { DbClient } from './client';
import { DbError } from './errors';
import type { PoolProfile } from './pool-profile';
import { POOLER_SESSION_REQUIRED_FIX, STATEMENT_BOUND_LOST_FIX } from './pooler-fix';
import { sql } from './sql';

/** The variable naming a connection pooler in this process's path. */
export const POOLER_ENV = 'DATABASE_POOLER';

/** What the pooler in the path multiplexes on: a whole client session, or one transaction. */
export type PoolerMode = 'session' | 'transaction';

/**
 * How long a statement may queue in the pooler for a backend, on top of the server's own bound.
 * `statement_timeout` starts only once the pooler assigns a backend, so a saturated pooler is not
 * a dead path; PgBouncer's default `query_wait_timeout` is 120 s, and past it the pooler answers
 * itself. Reproduced 2026-11-03: 20 busy server connections, `select 1` from `web` was retired at
 * 7005 ms on a healthy server without it.
 */
export const POOLER_WAIT_MS = 120_000;

const poolerInvalid = (received: string): DbError =>
  new DbError({
    code: 'X_ENV_MISSING',
    // `describeValue`, never the value, in the cause AND meta: a pooler URL pasted here carries its
    // password into the boot log and the `--json` payload, where no key is left to redact it by.
    cause: `DATABASE_POOLER is ${describeValue(received)}, which is not session or transaction`,
    fix: 'DATABASE_POOLER=session   # or transaction, or unset it',
    meta: { received: describeValue(received) },
  });

/**
 * `DATABASE_POOLER`, or nothing — and nothing keeps today's bytes. A switch and never a detection:
 * one pooler accepts the libpq `options` and drops them, so there is no failure to retry on. Env,
 * for `POOL_MAX_ENV`'s reason: one image, and the URL changes per environment. An unknown value
 * **refuses**, for that one's reason too: a typo here silently re-sends what the pooler refuses,
 * or strips the bounds off a connection that has no pooler at all. `postgresClient({ env })` is its
 * one reader in a process; everything else asks `client.pooler`.
 */
export function poolerFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PoolerMode | undefined {
  const raw = env[POOLER_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  if (raw === 'session' || raw === 'transaction') return raw;
  throw poolerInvalid(raw);
}

/** The deadline extension a pool gets: `0` with no pooler, the budget with one. */
export function poolerWaitFor(pooler: PoolerMode | undefined, waitMs: number | undefined): number {
  if (pooler === undefined) return 0;
  return waitMs === undefined
    ? POOLER_WAIT_MS
    : finiteCount('postgresClient', 'poolerWaitMs', waitMs);
}

/** `subject` is who was refused: `ROLE=migrate`, or the step that takes the migration lock. */
export const poolerSessionRequired = (subject: string): DbError =>
  new DbError({
    code: 'X_DB_POOLER_SESSION_REQUIRED',
    cause: `${subject} under DATABASE_POOLER=transaction: session advisory locks and replication need one backend, and through this pooler two migrators would both read true from pg_try_advisory_lock`,
    fix: POOLER_SESSION_REQUIRED_FIX,
    meta: { subject },
  });

/** One setting as the session reads it, beside what the role was sized around. Milliseconds. */
interface LostBound {
  readonly setting: 'statement_timeout' | 'idle_in_transaction_session_timeout';
  readonly appliedMs: number;
  readonly expectedMs: number;
}

/**
 * A report, logged and never thrown: a fleet already running this must not stop on upgrade. The
 * cause states the second cost, because it is not visible as a bound: the unanswered-statement
 * deadline still runs on the profile's number, so a long healthy statement reads as a dead path.
 */
export const statementBoundLost = (role: string, lost: readonly LostBound[]): DbError =>
  new DbError({
    code: 'X_DB_STATEMENT_BOUND_LOST',
    cause:
      lost
        .map(
          (bound) =>
            `${bound.setting} is ${String(bound.appliedMs)}ms, the ${role} role expects ${String(bound.expectedMs)}ms`,
        )
        .join('; ') +
      '. Nothing on the server ends a long statement now, and the client still judges one by the role bound: past statementTimeoutMs plus 5 s (plus poolerWaitMs behind a pooler) it answers X_DB_UNAVAILABLE and the pool is replaced, failing its siblings with it',
    fix: STATEMENT_BOUND_LOST_FIX,
    meta: { role, lost },
  });

/** One setting: what the session reads, and what the role's profile asks for. Milliseconds both. */
interface BoundReading {
  readonly applied: number;
  readonly expected: number;
}

export interface StatementBound {
  readonly statementTimeout: BoundReading;
  readonly idleInTransaction: BoundReading;
}

/**
 * The two bounds as the SESSION reads them. A pooler can accept the libpq `options` and drop them,
 * so what was sent says nothing: this is the only reading of what is in force. `pg_settings`, not
 * `show`: both are `ms`-unit settings, so `setting` is a number where `show` answers `10s`.
 */
export async function statementBound(
  client: DbClient & { readonly profile: PoolProfile },
): Promise<StatementBound> {
  const rows = await client.query<{ readonly name: string; readonly setting: string }>(
    sql`select name, setting from pg_settings where name in ('statement_timeout', 'idle_in_transaction_session_timeout')`,
  );
  const applied = (name: string): number =>
    Number(rows.find((row) => row.name === name)?.setting ?? 0);
  return {
    statementTimeout: {
      applied: applied('statement_timeout'),
      expected: client.profile.statementTimeoutMs,
    },
    idleInTransaction: {
      applied: applied('idle_in_transaction_session_timeout'),
      expected: client.profile.idleInTransactionMs,
    },
  };
}

/**
 * The verdict on a reading, or nothing. With no pooler named the framework sent the value, so any
 * difference is something in the path. With one named it did not, and one database user may serve
 * two roles, so only `0` — no bound at all, where the role has one — is a lost bound.
 */
export function lostStatementBound(
  bound: StatementBound,
  role: string,
  pooler: PoolerMode | undefined,
): DbError | undefined {
  const judged: readonly LostBound[] = (
    [
      ['statement_timeout', bound.statementTimeout],
      ['idle_in_transaction_session_timeout', bound.idleInTransaction],
    ] as const
  )
    .filter(([, reading]) =>
      pooler === undefined
        ? reading.applied !== reading.expected
        : reading.applied === 0 && reading.expected !== 0,
    )
    .map(([setting, reading]) => ({
      setting,
      appliedMs: reading.applied,
      expectedMs: reading.expected,
    }));
  return judged.length === 0 ? undefined : statementBoundLost(role, judged);
}
