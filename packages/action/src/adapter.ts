// `@ultimat3/action/adapter` — what an idempotency or meter store is built and installed from: the
// port interfaces, the errors a store throws, and the boot's installers with their resets. Never
// the `.` barrel: an app swaps a store in `apps/<app>/runtime.ts` (`idempotencyStore:`,
// `meterStore:`), so the only callers here are the cli boot, `@ultimat3/testing` and a store author.

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
