// `@ultimat3/db/diagnostics`: `dbDiagnostics()` and its row types. Its own entry because one caller
// runs it — `x db diagnostics` — while `@ultimat3/db` is imported by every role of every app: on the
// barrel these five modules were evaluated by every web, worker and migrate pod to serve nothing.

export type { DbDiagnostics, DbDiagnosticsOptions, DiagnosticSection } from './db-diagnostics';
export { DIAGNOSTICS_LIMIT, DIAGNOSTICS_TIMEOUT_MS, dbDiagnostics } from './db-diagnostics';
export type {
  ActivityRow,
  BlockerRow,
  DeadTupleRow,
  InvalidIndexRow,
  NotValidConstraintRow,
  SlowQueryRow,
  UnusedIndexRow,
} from './db-diagnostics-rows';
