// `@ultimat3/action/adapter` — what an idempotency, meter or audit store is built and installed
// from: the port interfaces, the errors a store throws, the boot's installers with their resets,
// and group commit for a sink author's own `writeMany`. Never the `.` barrel: an app swaps a store
// in `apps/<app>/runtime.ts`, so the callers here are the cli boot, `@ultimat3/testing` and authors.

export type { BatchAuditSink, BatchedAuditSink, BatchedAuditSinkOptions } from './audit-batch';
export {
  batchedAuditSink,
  DEFAULT_AUDIT_BATCH_MAX_DELAY_MS,
  DEFAULT_AUDIT_BATCH_MAX_RECORDS,
} from './audit-batch';
export {
  IdempotencyReservationLostError,
  IdempotencyStatusUnknownError,
} from './errors';
export type { HandlerOverride } from './handler-override';
export type {
  IdempotencyFailure,
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyScope,
  IdempotencyStatus,
  IdempotencyStore,
} from './idempotency';
export { installIdempotencyStore, resetIdempotency } from './idempotency';
export { overrideHandler } from './invoke';
export type { MeterDraw, MeterDrawResult, MeterKey, MeterStore } from './meter-store';
export { installMeterStore, resetMeterStore } from './meter-store';
