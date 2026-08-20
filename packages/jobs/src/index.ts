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
export {
  BackfillAppliedError,
  BackfillEnvironmentError,
  BackfillMigrationPendingError,
  BackfillPendingError,
  BackfillRunningError,
  BackfillStalledError,
  BackfillUnknownError,
} from './backfill-errors';
export type { BackfillGate, BackfillGateInput } from './backfill-gate';
export { checkBackfillEnvironment, gateBackfill } from './backfill-gate';
export type { BackfillProgress } from './backfill-inspect';
export { backfillForRun, inspectBackfills, toBackfillProgress } from './backfill-inspect';
export type {
  BackfillFilter,
  BackfillLedger,
  BackfillRun,
  BackfillStatus,
  BackfillVerdict,
} from './backfill-ledger';
export {
  BACKFILL_STATUSES,
  backfillChecksum,
  createMemoryBackfillLedger,
  decideBackfill,
  isBackfillStatus,
} from './backfill-ledger';
export type {
  BackfillPendingReport,
  BackfillState,
  BackfillStateRow,
} from './backfill-pending';
export {
  BACKFILL_STATES,
  isPendingBackfillState,
  PENDING_BACKFILL_STATES,
  pendingBackfills,
} from './backfill-pending';
export type { Pacer, PacerOptions } from './backfill-rate';
export { createPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';
export type { BackfillCount, BackfillDeclaration, BackfillOrigin } from './backfill-registry';
// `stampBackfill` is deliberately absent, for the reason `registerJob` is: a second way to make a
// handle claim it is a backfill would let a plain `job()` inherit the pending diff and the gate.
export {
  backfillOrigin,
  declarationOf,
  getBackfill,
  isBackfill,
  registeredBackfills,
} from './backfill-registry';
export type { JobDescriptor } from './describe';
export type {
  ClaimedJob,
  ClaimOptions,
  ConflictPolicy,
  EnqueueRequest,
  EnqueueResult,
  HeartbeatOptions,
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
  isJobState,
  JOB_STATES,
  jobDriver,
  resetJobDriver,
  setJobDriver,
} from './driver';
export type { MemoryDriverOptions, MemoryJobDriver } from './driver-memory';
export { createMemoryDriver } from './driver-memory';
export type { NatsDriverOptions } from './driver-nats';
export { createNatsDriver } from './driver-nats';
export type { PgDriverOptions, PgExecutor } from './driver-pg';
export { createPgDriver, createPgLeader } from './driver-pg';
export {
  SQL_ACK,
  SQL_ADVISORY_UNLOCK,
  SQL_BACKFILL_FINISH,
  SQL_BACKFILL_LIST,
  SQL_BACKFILL_PROGRESS,
  SQL_BACKFILL_START,
  SQL_CANCEL,
  SQL_CLAIM,
  SQL_ENQUEUE,
  SQL_HEARTBEAT,
  SQL_JOBS_TABLE,
  SQL_LEADER_ACQUIRE,
  SQL_LEADER_RELEASE,
  SQL_LEASE_ACQUIRE,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_NACK,
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_RELEASE,
  SQL_OUTBOX_STAGE,
  SQL_OUTBOX_TABLE,
  SQL_SCHEDULER_STATE_GET,
  SQL_SCHEDULER_STATE_MARK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
export type { RedisDriverOptions } from './driver-redis';
export { createRedisDriver } from './driver-redis';
export type { JobErrorCode } from './errors';
export {
  ActionJobUnbridgedError,
  CancelUnsupportedError,
  ConcurrencyUnenforceableError,
  DriverUnavailableError,
  IdempotencyRequiredError,
  JOB_ERROR_CODES,
  JOB_ERROR_TITLES,
  JobAbortedError,
  JobDuplicateError,
  JobMaxAttemptsError,
  JobNameTakenError,
  JobNotCancellableError,
  JobRowStatusUnknownError,
  JobSlotLostError,
  JobsNotImplementedError,
  JobTenantRequiredError,
  JobTimeoutError,
  LeaseLostError,
  OutboxNoTxError,
  StepDuplicateError,
} from './errors';
export type { EventBus, JobEvent, MemoryEventBusOptions, PublishOptions } from './events';
export { createMemoryEventBus, eventBus, publishEvent, setEventBus } from './events';
export type { PgEventBusOptions } from './events-pg';
export { createPgEventBus } from './events-pg';
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
  cancelJob,
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectManifest,
  inspectQueues,
  retryFromStep,
} from './inspect';
export type { AnyJobHandle, JobActor, JobDefinition, JobHandle, JobRunArgs } from './job';
export { describeJobs, getJob, isJobHandle, job, registeredJobs, resetJobs } from './job';
export type { HeldLease, LeaseStore, MemoryLeaseStoreOptions } from './leases';
export { createMemoryLeaseStore, jobLeaseKey } from './leases';
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
export {
  queueDeadJobs,
  queueOldestReady,
  recordQueueDeadJobs,
  recordQueueOldestReady,
} from './metrics';
export type {
  EnqueueOptions,
  JobsFacade,
  MemoryOutboxOptions,
  MemoryOutboxStore,
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
  setJobsFacade,
} from './outbox';
// One definition of the lease, consumed by both stores — a memory default and a pg default that
// could drift are two answers to "how long is a claim mine for", and the shorter one duplicates.
export { DEFAULT_OUTBOX_CLAIM_LEASE_MS } from './outbox-lease';
export type { PgOutboxOptions } from './outbox-pg';
export { createPgOutboxStore } from './outbox-pg';

export type { BackoffStrategy, Random, RetryDecision, RetryPolicy } from './retry';
export { backoffDelayMs, DEFAULT_RETRY, nextRetry, retrySchedule } from './retry';
export type { JobRetryDecision, JobStopReason } from './retry-classification';
export { classifyThrown, nextRetryForError } from './retry-classification';
export type {
  CronResolver,
  DispatchedOccurrence,
  LeaderElection,
  Scheduler,
  SchedulerOptions,
  SchedulerState,
} from './scheduler';
export { createMemorySchedulerState, createScheduler, soleLeader } from './scheduler';
export type { PgLeaseLeaderOptions } from './scheduler-pg';
export {
  createPgLeaseLeader,
  currentLeader,
  DEFAULT_LEADER_TTL_MS,
  pgSchedulerState,
} from './scheduler-pg';
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
  isStepStatus,
  isStepSuspension,
  MAX_TRACE_NAMES,
  STEP_STATUSES,
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
/**
 * The tenant a job's body runs under. The TYPE only: `NO_JOB_TENANT`, `jobRunActor` and
 * `jobTenantFor` stay unexported. The first would be a second spelling of `'none'` (axiom 1 — the
 * literal is what the type says and what a declaration reads as), and the other two are
 * `executeJob`'s and `job()`'s: a second caller deriving a run's org would be a second answer to
 * "whose tenant is this", which is the thing this declaration exists to make singular.
 */
export type { JobTenant } from './tenant';
export type { Worker, WorkerOptions, WorkerStats } from './worker';
export { createWorker } from './worker';
