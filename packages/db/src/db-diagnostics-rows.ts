// Single responsibility: one catalog row, as the driver handed it, into `dbDiagnostics`' typed
// row. Column names stay the SQL's (`db-diagnostics-sql.ts`); the fields are what `--json` prints.
// The two drivers disagree on `int8` (text, bigint or number), so every count is read here, once.

type Raw = Readonly<Record<string, unknown>>;
type Redact = (text: string) => string;

/** A count or an age in seconds, whichever type the driver chose; `null` when the server had none. */
const count = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

/** Statement text, shaped by the caller's redactor: never sent out as the server stored it. */
const statement = (value: unknown, redact: Redact): string | null => {
  const raw = text(value);
  return raw === null ? null : redact(raw);
};

export interface BlockerRow {
  readonly pid: number | null;
  readonly blockedBy: number | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly waitingSeconds: number | null;
  readonly query: string | null;
  readonly blockerState: string | null;
  readonly blockerTransactionSeconds: number | null;
  readonly blockerQuery: string | null;
}

export const blockerRow = (raw: Raw, redact: Redact): BlockerRow => ({
  pid: count(raw['pid']),
  blockedBy: count(raw['blocked_by']),
  waitEventType: text(raw['wait_event_type']),
  waitEvent: text(raw['wait_event']),
  waitingSeconds: count(raw['waiting_seconds']),
  query: statement(raw['query'], redact),
  blockerState: text(raw['blocker_state']),
  blockerTransactionSeconds: count(raw['blocker_transaction_seconds']),
  blockerQuery: statement(raw['blocker_query'], redact),
});

export interface ActivityRow {
  readonly pid: number | null;
  readonly role: string | null;
  readonly applicationName: string | null;
  readonly state: string | null;
  readonly waitEventType: string | null;
  readonly waitEvent: string | null;
  readonly transactionSeconds: number | null;
  readonly querySeconds: number | null;
  /** False when this role lacks `pg_read_all_stats` for that session: a fact, not an error. */
  readonly queryVisible: boolean;
  readonly query: string | null;
}

export const activityRow = (raw: Raw, redact: Redact): ActivityRow => {
  const queryVisible = flag(raw['query_visible']) ?? false;
  return {
    pid: count(raw['pid']),
    role: text(raw['role']),
    applicationName: text(raw['application_name']),
    state: text(raw['state']),
    waitEventType: text(raw['wait_event_type']),
    waitEvent: text(raw['wait_event']),
    transactionSeconds: count(raw['transaction_seconds']),
    querySeconds: count(raw['query_seconds']),
    queryVisible,
    query: queryVisible ? statement(raw['query'], redact) : null,
  };
};

export interface SlowQueryRow {
  readonly queryId: string | null;
  readonly calls: number | null;
  readonly totalMs: number | null;
  readonly meanMs: number | null;
  readonly rows: number | null;
  readonly query: string | null;
}

export const slowQueryRow = (raw: Raw, redact: Redact): SlowQueryRow => ({
  queryId: text(raw['query_id']),
  calls: count(raw['calls']),
  totalMs: count(raw['total_ms']),
  meanMs: count(raw['mean_ms']),
  rows: count(raw['rows']),
  query: statement(raw['query'], redact),
});

export interface UnusedIndexRow {
  readonly schema: string | null;
  readonly table: string | null;
  readonly index: string | null;
  readonly sizeBytes: number | null;
  /** Seconds since this database's counters were reset; `null` = never reset. */
  readonly statsAgeSeconds: number | null;
  /** Counters are per server: a replica's zero says nothing of the primary's scans. */
  readonly replica: boolean | null;
}

export const unusedIndexRow = (raw: Raw): UnusedIndexRow => ({
  schema: text(raw['schema']),
  table: text(raw['table_name']),
  index: text(raw['index_name']),
  sizeBytes: count(raw['size_bytes']),
  statsAgeSeconds: count(raw['stats_age_seconds']),
  replica: flag(raw['replica']),
});

export interface InvalidIndexRow {
  readonly schema: string | null;
  readonly table: string | null;
  readonly index: string | null;
}

export const invalidIndexRow = (raw: Raw): InvalidIndexRow => ({
  schema: text(raw['schema']),
  table: text(raw['table_name']),
  index: text(raw['index_name']),
});

export interface NotValidConstraintRow {
  readonly schema: string | null;
  readonly table: string | null;
  readonly constraint: string | null;
  /** `check`, `foreign-key`, or Postgres' own one-letter `contype` for anything else. */
  readonly kind: string | null;
}

export const notValidConstraintRow = (raw: Raw): NotValidConstraintRow => ({
  schema: text(raw['schema']),
  table: text(raw['table_name']),
  constraint: text(raw['constraint_name']),
  kind: text(raw['kind']),
});

export interface DeadTupleRow {
  readonly schema: string | null;
  readonly table: string | null;
  readonly live: number | null;
  readonly dead: number | null;
  readonly autovacuumAgeSeconds: number | null;
  readonly vacuumAgeSeconds: number | null;
  readonly analyzeAgeSeconds: number | null;
}

export const deadTupleRow = (raw: Raw): DeadTupleRow => ({
  schema: text(raw['schema']),
  table: text(raw['table_name']),
  live: count(raw['live']),
  dead: count(raw['dead']),
  autovacuumAgeSeconds: count(raw['autovacuum_age_seconds']),
  vacuumAgeSeconds: count(raw['vacuum_age_seconds']),
  analyzeAgeSeconds: count(raw['analyze_age_seconds']),
});
