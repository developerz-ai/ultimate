// `@ultimat3/jobs/adapter` — what a queue, an event bus or a durable store is built and installed
// from: the port interfaces (outbox, step and lease stores too), a driver's errors, the installers
// and their resets. Never the `.` barrel: an app swaps a backend in `apps/<app>/runtime.ts`, so
// the callers here are the cli boot, `@ultimat3/testing` and a driver's own author.

export type {
  AckOptions,
  ClaimedJob,
  ClaimIdentity,
  ClaimOptions,
  ConflictPolicy,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
  JobDriver,
  JobRecord,
  JobState,
  NackOptions,
  QueueDemand,
  QueueStats,
  SettleBy,
} from './driver';
export { installJobDriver, resetJobDriver } from './driver';
export {
  ClaimQueuesEmptyError,
  DriverUnavailableError,
  JobDuplicateError,
  JobRowStatusUnknownError,
  LeaseLostError,
} from './errors';
export { JobNotFoundError, JobNotRequeueableError } from './errors-requeue';
export type { EventBus, JobEvent, PublishOptions } from './events';
export { freshDefaultEventBus, installEventBus, resetEventBus } from './events';
export type { LeaseStore } from './leases';
export type { OutboxRecord, OutboxStore } from './outbox';
export { fireThroughDriver } from './scheduler-state';
export type { StepStore } from './steps-store';
