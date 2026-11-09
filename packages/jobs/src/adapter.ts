// `@ultimat3/jobs/adapter` — what a queue or an event bus is built and installed from: the two port
// interfaces, the errors a driver throws, and the boot's installers with their resets. Never the
// `.` barrel: an app swaps a backend in `apps/<app>/runtime.ts` (`jobs:`, `eventBus:`), so the only
// callers here are the cli boot, `@ultimat3/testing`, and a driver's own author.

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
