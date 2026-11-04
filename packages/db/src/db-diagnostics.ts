// Single responsibility: `dbDiagnostics()` — what the database is doing right now (blockers,
// activity, slow statements, unused and invalid indexes, unvalidated constraints, dead tuples), as
// facts and never a verdict. `db-health.ts` stays the readiness probe `/readyz` reads.

import { finiteCount, isUltimateError, renderThrowable, type Scheduler } from '@ultimat3/core';
import type { DbClient } from './client';
import { commandDeadline, EXPIRED, within } from './db-diagnostics-deadline';
import { redactQueryText } from './db-diagnostics-redact';
import {
  type ActivityRow,
  activityRow,
  type BlockerRow,
  blockerRow,
  type DeadTupleRow,
  deadTupleRow,
  type InvalidIndexRow,
  invalidIndexRow,
  type NotValidConstraintRow,
  notValidConstraintRow,
  type SlowQueryRow,
  slowQueryRow,
  type UnusedIndexRow,
  unusedIndexRow,
} from './db-diagnostics-rows';
import {
  ACTIVITY_SQL,
  BLOCKERS_SQL,
  DEAD_TUPLES_SQL,
  INVALID_INDEXES_SQL,
  NOT_VALID_CONSTRAINTS_SQL,
  SLOW_QUERIES_SQL,
  UNUSED_INDEXES_SQL,
} from './db-diagnostics-sql';
import { dbUnavailable } from './errors';
import { unrefSchedule } from './pool-timer';
import { readOnlyQuery } from './readonly-query';

/** Per statement. A catalog read that takes longer is itself the finding, reported as its section. */
export const DIAGNOSTICS_TIMEOUT_MS = 2_000;
/** Rows per section, fetched through a cursor so the server stops there. */
export const DIAGNOSTICS_LIMIT = 20;
/** The client's own wait per statement: the server's bound plus a second for the answer to land. */
export const DIAGNOSTICS_SECTION_DEADLINE_MS = DIAGNOSTICS_TIMEOUT_MS + 1_000;
/** The whole command. Past it, the sections not yet asked are reported unsent. */
export const DIAGNOSTICS_DEADLINE_MS = 15_000;

export interface DbDiagnosticsOptions {
  /** Override the ambient pool. */
  readonly client?: DbClient | undefined;
  /** Rows per section; a whole number ≥ 1. Default `DIAGNOSTICS_LIMIT`. */
  readonly limit?: number | undefined;
  /** Arms both client-side deadlines. A seam for tests; default an unref'd `setTimeout`. */
  readonly schedule?: Scheduler | undefined;
}

/** A section answered, or why it could not be and what would make it answer. Never a throw. */
export type DiagnosticSection<Row> =
  | { readonly available: true; readonly rows: readonly Row[] }
  | {
      readonly available: false;
      readonly code: string;
      readonly reason: string;
      readonly fix: string;
    };

export interface DbDiagnostics {
  readonly blockers: DiagnosticSection<BlockerRow>;
  readonly activity: DiagnosticSection<ActivityRow>;
  readonly slowQueries: DiagnosticSection<SlowQueryRow>;
  readonly unusedIndexes: DiagnosticSection<UnusedIndexRow>;
  readonly invalidIndexes: DiagnosticSection<InvalidIndexRow>;
  readonly notValidConstraints: DiagnosticSection<NotValidConstraintRow>;
  readonly deadTuples: DiagnosticSection<DeadTupleRow>;
}

/** An operator's act, in the database: this framework never creates an extension for the app. */
export const SLOW_QUERIES_FIX =
  `psql "$DATABASE_URL" -c 'create extension if not exists pg_stat_statements'` +
  "   # after shared_preload_libraries = 'pg_stat_statements' in postgresql.conf and a server restart";

/** A section the client stopped waiting for, or never sent: the server's own timeout code. */
const TIMED_OUT = 'X_DB_STATEMENT_TIMEOUT';

/** What a section without an `UltimateError` of its own hands out: the same read, by hand. */
const GENERIC_FIX =
  'x db diagnostics --json   # re-run once the load that timed this read out passes';

/** `scheme://user:password@host` → `scheme://***@host`: a reason is printed, a credential never. */
const scrubCredentials = (text: string): string =>
  text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]*@/gi, '$1***@');

/**
 * Every section is one statement through `readOnlyQuery` — its own `BEGIN READ ONLY`, a 2 s
 * `statement_timeout`, a cursor capped at `limit` — run one after another, so a diagnostic holds
 * one connection and never seven. A section that fails is reported in place: one timeout does not
 * lose the other six. The single throw is a probe that cannot open a connection at all.
 */
export async function dbDiagnostics(options: DbDiagnosticsOptions = {}): Promise<DbDiagnostics> {
  const limit = finiteCount('dbDiagnostics', 'limit', options.limit ?? DIAGNOSTICS_LIMIT, 1);
  const read = { client: options.client, timeoutMs: DIAGNOSTICS_TIMEOUT_MS } as const;
  const schedule = options.schedule ?? unrefSchedule;
  const sectionMs = DIAGNOSTICS_SECTION_DEADLINE_MS;
  try {
    const probe = await within(readOnlyQuery('select 1', read), sectionMs, schedule);
    if (probe === EXPIRED) {
      throw dbUnavailable(`x db diagnostics had no answer to select 1 within ${sectionMs}ms`);
    }
  } catch (error) {
    throw isUltimateError(error)
      ? error
      : dbUnavailable('x db diagnostics could not open a connection', error);
  }
  const deadline = commandDeadline(DIAGNOSTICS_DEADLINE_MS, schedule);
  const section = async <Row>(
    statement: string,
    toRow: (raw: Readonly<Record<string, unknown>>) => Row,
    fixFor?: (code: string, reason: string) => string | undefined,
  ): Promise<DiagnosticSection<Row>> => {
    if (deadline.passed()) {
      const reason = `not sent: x db diagnostics passed its ${DIAGNOSTICS_DEADLINE_MS}ms deadline first`;
      return { available: false, code: TIMED_OUT, reason, fix: GENERIC_FIX };
    }
    try {
      const answer = await within(
        readOnlyQuery<Readonly<Record<string, unknown>>>(statement, { ...read, maxRows: limit }),
        sectionMs,
        schedule,
      );
      if (answer === EXPIRED) {
        // The embedded database cannot interrupt the statement, so it may still be running.
        const reason = `no answer within ${sectionMs}ms; the client stopped waiting`;
        return { available: false, code: TIMED_OUT, reason, fix: GENERIC_FIX };
      }
      return { available: true, rows: answer.rows.map(toRow) };
    } catch (error) {
      const code = isUltimateError(error) ? error.code : 'X_DB_STATEMENT_FAILED';
      const reason = scrubCredentials(
        isUltimateError(error) ? error.cause : renderThrowable(error),
      );
      const own = isUltimateError(error) ? error.fix : undefined;
      const fix = fixFor?.(code, reason) ?? own ?? GENERIC_FIX;
      return { available: false, code, reason, fix: scrubCredentials(fix) };
    }
  };
  try {
    return await readSections(section);
  } finally {
    deadline.release();
  }
}

type Section = <Row>(
  statement: string,
  toRow: (raw: Readonly<Record<string, unknown>>) => Row,
  fixFor?: (code: string, reason: string) => string | undefined,
) => Promise<DiagnosticSection<Row>>;

/** The seven, in order, each through `section`. */
async function readSections(section: Section): Promise<DbDiagnostics> {
  return {
    blockers: await section(BLOCKERS_SQL, (raw) => blockerRow(raw, redactQueryText)),
    activity: await section(ACTIVITY_SQL, (raw) => activityRow(raw, redactQueryText)),
    // `42P01` (not installed) and `55000` (installed, not preloaded) both mean the extension is
    // not answering — its own fix, never `X_DB_SCHEMA_STALE`'s `x db gen`.
    slowQueries: await section(
      SLOW_QUERIES_SQL,
      (raw) => slowQueryRow(raw, redactQueryText),
      (code, reason) =>
        code === 'X_DB_SCHEMA_STALE' || reason.includes('pg_stat_statements')
          ? SLOW_QUERIES_FIX
          : undefined,
    ),
    unusedIndexes: await section(UNUSED_INDEXES_SQL, unusedIndexRow),
    invalidIndexes: await section(INVALID_INDEXES_SQL, invalidIndexRow),
    notValidConstraints: await section(NOT_VALID_CONSTRAINTS_SQL, notValidConstraintRow),
    deadTuples: await section(DEAD_TUPLES_SQL, deadTupleRow),
  };
}
