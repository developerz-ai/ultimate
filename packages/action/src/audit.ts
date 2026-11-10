/**
 * The audit seam, as this package exposes it: THAT an action or mutator can be recorded at all.
 * The contract — the record, the sink, the one installed-sink slot — moved to `@ultimat3/core`'s
 * `audit.ts` so `@ultimat3/query` (a sibling this package cannot import) writes the same record
 * into the same sink. The TYPES are re-exported for this package's own modules; the slot's VALUES
 * (`getAuditSink`; the boot's `installAuditSink` is `@ultimat3/core/adapter`'s) are imported from
 * core and never re-exported — a second import path for one value is `X_HELPER_COPY` (`bun run flight-copies`).
 */

export type { AuditFailure, AuditOutcome, AuditRecord, AuditSink } from '@ultimat3/core';
