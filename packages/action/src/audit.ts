/**
 * The audit seam, as this package exposes it: THAT an action or mutator can be recorded at all.
 * The contract — the record, the sink, the one installed-sink slot — moved to `@ultimat3/core`'s
 * `audit.ts` so `@ultimat3/query` (a sibling this package cannot import) writes the same record
 * into the same sink. Re-exported under the names this package always had, so no import moves.
 */

export type { AuditFailure, AuditOutcome, AuditRecord, AuditSink } from '@ultimat3/core';
export { getAuditSink, resetAuditSink, setAuditSink } from '@ultimat3/core';
