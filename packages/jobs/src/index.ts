// Public API of @ultimat3/jobs. Explicit, no `export *`.
//
// `registerJob`/`registerJobs`/`registerTask`/`registerTasks`/`nameJobs`/`nameTasks` are
// deliberately absent. `defineApi({ jobs, tasks })` is where a module is handed over and nothing
// else registers (CLAUDE.md); it reaches them through core's registrar table, which the
// side-effect import below fills. Exporting them would offer a second registration path that
// bypasses `defineApi`'s own result — the ambiguity axiom 1 exists to refuse.
import './register';

/** Re-exported so a `job`/`task` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type {
  BackfillBatch,
  BackfillDefinition,
  BackfillInput,
  BackfillReport,
} from './backfill';
export { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
export type { JobDescriptor } from './describe';
export type {
  ClaimedJob,
  ClaimOptions,
  ConflictPolicy,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  JobFilter,
  JobIntrospection,
  JobRecord,
  JobState,
  NackOptions,
  QueueStats,
} from './driver';
export {
  DEFAULT_QUEUE,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  jobDriver,
  resetJobDriver,
  setJobDriver,
} from './driver';
export type { MemoryDriverOptions } from './driver-memory';
export { createMemoryDriver } from './driver-memory';
export type { NatsDriverOptions } from './driver-nats';
export { createNatsDriver } from './driver-nats';
export type { PgDriverOptions, PgExecutor } from './driver-pg';
export { createPgDriver, createPgLeader } from './driver-pg';
export {
  SQL_ACK,
  SQL_ADVISORY_UNLOCK,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_HEARTBEAT,
  SQL_JOBS_TABLE,
  SQL_NACK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
export type { RedisDriverOptions } from './driver-redis';
export { createRedisDriver } from './driver-redis';
export type { JobErrorCode } from './errors';
export {
  DriverUnavailableError,
  IdempotencyRequiredError,
  JOB_ERROR_CODES,
  JOB_ERROR_TITLES,
  JobAbortedError,
  JobDuplicateError,
  JobMaxAttemptsError,
  JobNameTakenError,
  JobsNotImplementedError,
  JobTimeoutError,
  OutboxNoTxError,
  StepDuplicateError,
} from './errors';
export type { EventBus, JobEvent, MemoryEventBusOptions, PublishOptions } from './events';
export { createMemoryEventBus, eventBus, publishEvent, setEventBus } from './events';
export type { ExecuteJobOptions, JobExecution, JobOutcome } from './execute';
export { executeJob } from './execute';
export type {
  DeadLetterEntry,
  JobsManifest,
  JobTrace,
  QueueDepthReport,
  StepTrace,
} from './inspect';
export {
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectManifest,
  inspectQueues,
  retryFromStep,
} from './inspect';
export type { AnyJobHandle, JobActor, JobDefinition, JobHandle, JobRunArgs } from './job';
export { describeJobs, getJob, isJobHandle, job, registeredJobs, resetJobs } from './job';
export type {
  Lease,
  LimitConfig,
  Limiter,
  LimitKey,
  LimitReason,
  LimitSnapshot,
  RateLimit,
} from './limits';
export { createLimiter, NO_TENANT, tenantKeyFrom } from './limits';
export type {
  EnqueueOptions,
  JobsFacade,
  OutboxDeps,
  OutboxRecord,
  OutboxRelay,
  OutboxStore,
  RelayOptions,
} from './outbox';
export {
  createJobsFacade,
  createMemoryOutboxStore,
  createOutboxRelay,
  enqueueInTx,
  jobsFacade,
  resetJobsFacade,
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_STAGE,
  SQL_OUTBOX_TABLE,
  setJobsFacade,
} from './outbox';

export type { BackoffStrategy, Random, RetryDecision, RetryPolicy } from './retry';
export { backoffDelayMs, DEFAULT_RETRY, nextRetry, retrySchedule } from './retry';
export type {
  CronResolver,
  DispatchedOccurrence,
  LeaderElection,
  Scheduler,
  SchedulerOptions,
  SchedulerState,
} from './scheduler';
export { createMemorySchedulerState, createScheduler, soleLeader } from './scheduler';
export type {
  EventLookup,
  StepApi,
  StepRecord,
  StepRunner,
  StepRunnerOptions,
  StepStatus,
  StepStore,
  WaitForEventOptions,
} from './steps';
export {
  createMemoryStepStore,
  createStepRunner,
  isStepSuspension,
  StepSuspension,
} from './steps';
export type {
  CatchUpPolicy,
  TaskDefinition,
  TaskDescriptor,
  TaskEnqueueEntry,
  TaskHandle,
  TaskJobResult,
} from './task';
export { getTask, isTaskHandle, registeredTasks, resetTasks, task } from './task';
export type { Worker, WorkerOptions, WorkerStats } from './worker';
export { createWorker } from './worker';
