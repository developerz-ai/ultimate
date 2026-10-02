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
  /** `undefined_column` — an entity edited before the migration that adds the column ran. */
  undefinedColumn: '42703',
  /** `undefined_function` and `undefined_object` — with `undefined_table`, "not created YET". */
  undefinedFunction: '42883',
  undefinedObject: '42704',
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

/** A field off a value that may fight being read — `stringField`'s shape, for a non-string. */
function unknownField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Five characters, digits and uppercase letters — `42P01`, never `ERR_POSTGRES_SERVER_ERROR`. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/;

/**
 * Whether five characters of that shape are a SQLSTATE, decided by where the object CAME FROM —
 * the shape alone cannot say. `EPIPE` and `E2BIG` are errno names of exactly that shape, and
 * `raise exception … using errcode = 'ABCDE'` is a legal state with no digit in it, so a rule
 * about letters and digits is wrong in both directions.
 *
 * Measured on Bun.SQL against Postgres 17 and on PGlite: a server ErrorResponse carries
 * `severity` on both drivers, and nothing the socket layer throws does. A syscall error carries
 * `syscall` and a NUMERIC `errno`. An object marked as neither — a fake, a wrapper, a driver this
 * package has not measured — keeps the old reading only for a state that carries a digit, which
 * is every state Postgres itself defines and no bare errno name this package has been handed.
 */
function isState(holder: unknown, candidate: string): boolean {
  if (!SQLSTATE_SHAPE.test(candidate)) return false;
  if (stringField(holder, 'severity') !== undefined) return true;
  if (stringField(holder, 'syscall') !== undefined) return false;
  if (typeof unknownField(holder, 'errno') === 'number') return false;
  return /[0-9]/.test(candidate);
}

/** How deep a wrap may nest before we stop looking. `DbError` adds exactly one level. */
const MAX_WRAPS = 4;

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
 * The shape test keeps `ERR_POSTGRES_SERVER_ERROR` and `X_DB_UNAVAILABLE` out — neither is five
 * characters of `[0-9A-Z]` — and `isState` keeps an errno NAME out, which the shape cannot.
 */
export function sqlState(error: unknown): string | undefined {
  let value = error;
  for (let depth = 0; depth < MAX_WRAPS; depth += 1) {
    if (value === undefined || value === null) return undefined;
    const errno = stringField(value, 'errno');
    if (errno !== undefined && isState(value, errno)) return errno;
    const code = stringField(value, 'code');
    if (code !== undefined && isState(value, code)) return code;
    value = unknownField(value, 'sourceError');
  }
  return undefined;
}

/** The codes a SQLSTATE can classify into. `errors.ts` owns their titles and their fixes. */
export type DbSqlStateCode =
  | 'X_DB_SCHEMA_STALE'
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
  // Both class 42 "the schema does not have what this statement names": a table or a column
  // declared in code whose migration has not run. One code, because the instruction is one
  // instruction — generate the migration and apply it — and the cause names which it was.
  [SQLSTATE.undefinedTable]: 'X_DB_SCHEMA_STALE',
  [SQLSTATE.undefinedColumn]: 'X_DB_SCHEMA_STALE',
  [SQLSTATE.uniqueViolation]: 'X_DB_UNIQUE_VIOLATION',
  [SQLSTATE.foreignKeyViolation]: 'X_DB_FOREIGN_KEY_VIOLATION',
  [SQLSTATE.serializationFailure]: 'X_DB_SERIALIZATION_FAILURE',
  [SQLSTATE.deadlockDetected]: 'X_DB_SERIALIZATION_FAILURE',
  [SQLSTATE.queryCanceled]: 'X_DB_STATEMENT_TIMEOUT',
  [SQLSTATE.lockNotAvailable]: 'X_DB_LOCK_TIMEOUT',
  [SQLSTATE.tooManyConnections]: 'X_DB_POOL_EXHAUSTED',
  [SQLSTATE.outOfMemory]: 'X_DB_POOL_EXHAUSTED',
} as const);

/**
 * `undefined` when the state is absent or not in the table. What the caller does with that is
 * `driverError`'s decision, not this file's: a state the table does not name still proves the
 * statement REACHED a server, which is the opposite of unavailable.
 */
export function sqlStateCode(error: unknown): DbSqlStateCode | undefined {
  const state = sqlState(error);
  return state === undefined ? undefined : DB_SQLSTATE_CODES[state];
}

/** Whether re-running the whole transaction is the documented answer. `withTransaction`'s retry. */
export function isRetryableState(error: unknown): boolean {
  const state = sqlState(error);
  return state === SQLSTATE.serializationFailure || state === SQLSTATE.deadlockDetected;
}
