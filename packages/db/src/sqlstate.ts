// Single responsibility: what the *database* said went wrong. One reader for the SQLSTATE a driver
// error carries and one closed table from the states this framework can act on to a code. Two
// drivers spell the field differently, so the read lives here once — a second copy is a second
// answer to "is this a unique violation".

import { stringField } from '@ultimat3/core';

/**
 * The SQLSTATEs the framework names. A closed list on purpose: a table enumerating all ~250 of
 * Postgres' classes would be a second copy of the manual, and every entry here has a `fix:` an
 * operator can run. Everything absent is `X_DB_UNAVAILABLE`, which is the honest answer to "the
 * database said something we have no instruction for".
 */
export const SQLSTATE = Object.freeze({
  /** `undefined_table` — the ledger's absence is a class, not a message to match on. */
  undefinedTable: '42P01',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  /** `query_canceled` — what `statement_timeout` raises. */
  queryCanceled: '57014',
  /** `lock_not_available` — what `lock_timeout` raises while a DDL statement queues. */
  lockNotAvailable: '55P03',
  tooManyConnections: '53300',
  outOfMemory: '53200',
} as const);

/** Five characters, digits and uppercase letters — `42P01`, never `ERR_POSTGRES_SERVER_ERROR`. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/** How deep a wrap may nest before we stop looking. `DbError` adds exactly one level. */
const MAX_WRAPS = 4;

/** A field off a value that may fight being read — `stringField`'s shape, for a non-string. */
function unknownField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The SQLSTATE a driver error carries, unwrapping `DbError.sourceError` on the way, or `undefined`
 * when the failure never reached the server — a refused socket, a closed pool, a DNS miss.
 *
 * **`errno` is read before `code`, and that ordering is the bug this function fixes.** Measured on
 * bun 1.3.14 against Postgres 17: `Bun.SQL` puts `ERR_POSTGRES_SERVER_ERROR` on `code` and the
 * SQLSTATE on `errno`, while PGlite — node-postgres' protocol — puts the SQLSTATE on `code` and
 * has no `errno` at all. Reading `code` alone is correct on the embedded driver and wrong on every
 * production one, which is exactly the split `isLedgerMissing` was living on.
 *
 * The shape test is what keeps the two apart: `ERR_POSTGRES_SERVER_ERROR` and `X_DB_UNAVAILABLE`
 * are not five characters of `[0-9A-Z]`, and no SQLSTATE contains an underscore.
 */
export function sqlState(error: unknown): string | undefined {
  let value = error;
  for (let depth = 0; depth < MAX_WRAPS; depth += 1) {
    if (value === undefined || value === null) return undefined;
    const errno = stringField(value, 'errno');
    if (errno !== undefined && SQLSTATE_SHAPE.test(errno)) return errno;
    const code = stringField(value, 'code');
    if (code !== undefined && SQLSTATE_SHAPE.test(code)) return code;
    value = unknownField(value, 'sourceError');
  }
  return undefined;
}

/** The codes a SQLSTATE can classify into. `errors.ts` owns their titles and their fixes. */
export type DbSqlStateCode =
  | 'X_DB_UNIQUE_VIOLATION'
  | 'X_DB_FOREIGN_KEY_VIOLATION'
  | 'X_DB_SERIALIZATION_FAILURE'
  | 'X_DB_STATEMENT_TIMEOUT'
  | 'X_DB_LOCK_TIMEOUT'
  | 'X_DB_POOL_EXHAUSTED';

/**
 * SQLSTATE to code, closed. `40P01` (deadlock) joins `40001` because the instruction is identical
 * — re-run the whole transaction — and a caller branching on which of the two it lost to would be
 * writing the same retry twice. `53200` (out_of_memory) joins `53300` for the same reason: both are
 * class 53, insufficient resources, and both are answered by asking for fewer connections.
 */
export const DB_SQLSTATE_CODES: Readonly<Record<string, DbSqlStateCode>> = Object.freeze({
  [SQLSTATE.uniqueViolation]: 'X_DB_UNIQUE_VIOLATION',
  [SQLSTATE.foreignKeyViolation]: 'X_DB_FOREIGN_KEY_VIOLATION',
  [SQLSTATE.serializationFailure]: 'X_DB_SERIALIZATION_FAILURE',
  [SQLSTATE.deadlockDetected]: 'X_DB_SERIALIZATION_FAILURE',
  [SQLSTATE.queryCanceled]: 'X_DB_STATEMENT_TIMEOUT',
  [SQLSTATE.lockNotAvailable]: 'X_DB_LOCK_TIMEOUT',
  [SQLSTATE.tooManyConnections]: 'X_DB_POOL_EXHAUSTED',
  [SQLSTATE.outOfMemory]: 'X_DB_POOL_EXHAUSTED',
} as const);

/** `undefined` when the state is unknown or absent — the caller then reports unavailability. */
export function sqlStateCode(error: unknown): DbSqlStateCode | undefined {
  const state = sqlState(error);
  return state === undefined ? undefined : DB_SQLSTATE_CODES[state];
}

/** Whether re-running the whole transaction is the documented answer. `withTransaction`'s retry. */
export function isRetryableState(error: unknown): boolean {
  const state = sqlState(error);
  return state === SQLSTATE.serializationFailure || state === SQLSTATE.deadlockDetected;
}
