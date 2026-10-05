// Public API of @ultimat3/jobs. Explicit, no `export *`.
//
// `registerJob`/`registerJobs`/`registerTask`/`registerTasks`/`nameJobs`/`nameTasks` are
// deliberately absent. `defineApi({ jobs, tasks })` is where a module is handed over and nothing
// else registers (CLAUDE.md); it reaches them through core's registrar table, which the
// side-effect import below fills. Exporting them would offer a second registration path that
// bypasses `defineApi`'s own result — the ambiguity axiom 1 exists to refuse.
import './register';

// The wire format, RE-EXPORTED from `@ultimat3/core` and never re-declared: it is one module at
// the tier both halves can reach, because this package signs a delivery, `@ultimat3/http` verifies
// one, and neither may import the other. Re-exported here so a `job` file needs one import rather
// than two — the same reason `t` is re-exported above.
export type { PgExecutor, WebhookMacInput, WebhookSigningInput } from '@ultimat3/core';
export {
  isCanonicalWebhookField,
  WEBHOOK_FIELD_MAX,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TOPIC_HEADER,
  webhookHeaders,
  webhookMac,
  webhookSignature,
  webhookSigningString,
} from '@ultimat3/core';
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
export type { AnnounceExhaustedOptions, ExhaustedCounts } from './claim-exhausted';
export { announceExhausted } from './claim-exhausted';
export type { JobConcurrency, KeyedConcurrency, WhenBusy } from './concurrency';
export { MAX_CONCURRENCY_KEY_LENGTH, WHEN_BUSY } from './concurrency';
export type { JobConcurrencyDescriptor, JobDescriptor } from './describe';
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
  QueueStats,
  SettleBy,
} from './driver';
export {
  assertClaimBounds,
  assertClaimQueues,
  claimOf,
  DEFAULT_QUEUE,
  DEFAULT_VISIBILITY_TIMEOUT_MS,
  isJobState,
  JOB_STATES,
  jobDriver,
  LEASE_LAPSED_FINAL_ATTEMPT,
  LIVE_STATES,
  nackState,
  resetJobDriver,
  setJobDriver,
} from './driver';
export type { MemoryDriverOptions, MemoryJobDriver } from './driver-memory';
export { createMemoryDriver } from './driver-memory';
export type { NatsDriverOptions } from './driver-nats';
export { createNatsDriver } from './driver-nats';
export type { PgDriverOptions } from './driver-pg';
export { createPgDriver, createPgLeader } from './driver-pg';
export {
  SQL_COUNTER_DROP,
  SQL_COUNTER_FOLD,
  SQL_COUNTER_TOTALS,
  SQL_COUNTERS,
  SQL_JOB_PROGRESS,
  SQL_JOB_PROMOTE,
  SQL_JOB_REMOVE,
  SQL_JOB_REMOVE_MANY,
  SQL_JOB_REQUEUE_MANY,
  SQL_PAUSE,
  SQL_PAUSED,
  SQL_RESUME,
  SQL_SCHEDULER_FIRE,
  SQL_WORKER_ANNOUNCE,
  SQL_WORKER_FORGET,
  SQL_WORKERS,
} from './driver-pg-operator-sql';
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
  SQL_LEASE_HOLDERS,
  SQL_LEASE_RELEASE,
  SQL_LEASE_RENEW,
  SQL_NACK,
  SQL_OUTBOX_CLAIM,
  SQL_OUTBOX_MARK_PUBLISHED,
  SQL_OUTBOX_RELEASE,
  SQL_OUTBOX_STAGE,
  SQL_SCHEDULER_STATE_GET,
  SQL_SCHEDULER_STATE_MARK,
  SQL_STATS,
  SQL_STEP_GET,
  SQL_STEP_PUT,
  SQL_TRY_ADVISORY_LOCK,
} from './driver-pg-sql';
export type { RedisDriverOptions } from './driver-redis';
export { createRedisDriver } from './driver-redis';
export { signalEnqueued, signalStaged } from './enqueue-signal';
export type { JobErrorCode } from './errors';
export {
  ActionJobUnbridgedError,
  CancelUnsupportedError,
  ClaimQueuesEmptyError,
  DriverUnavailableError,
  IdempotencyRequiredError,
  JOB_ERROR_CODES,
  JOB_ERROR_TITLES,
  JobAbortedError,
  JobDrainedError,
  JobDuplicateError,
  JobMaxAttemptsError,
  JobNameTakenError,
  JobNotCancellableError,
  JobRowStatusUnknownError,
  JobSlotLostError,
  JobTenantRequiredError,
  JobTimeoutError,
  LeaseLostError,
  OutboxNoTxError,
  StepDuplicateError,
} from './errors';
export {
  ConcurrencyUnenforceableError,
  JobConcurrencyInvalidError,
  JobConcurrencyKeyInvalidError,
  JobKeyBusyError,
} from './errors-concurrency';
export { JobDeclarationInvalidError } from './errors-declaration';
export {
  JobNotPromotableError,
  JobNotRemovableError,
  JobOnSettledFailedError,
  JobPageInvalidError,
} from './errors-operator';
export { JobNotFoundError, JobNotRequeueableError } from './errors-requeue';
export type { EventBus, JobEvent, MemoryEventBusOptions, PublishOptions } from './events';
export {
  createMemoryEventBus,
  EVENTS_PURGE_TARGET,
  eventBus,
  eventsPurgeTarget,
  publishEvent,
  resetEventBus,
  setEventBus,
} from './events';
export type { PgEventBusOptions } from './events-pg';
export { createPgEventBus } from './events-pg';
export type { ExecuteJobOptions, JobExecution, JobOutcome } from './execute';
export { executeJob } from './execute';
export type { ExportDefinition, ExportReport } from './export';
export { DEFAULT_EXPORT_BATCH, DEFAULT_EXPORT_MAX_PART_BYTES, exportRows } from './export';
export { ExportPartTooLargeError, ExportRowInvalidError } from './export-errors';
export type { EncodePageInput, ExportFormat, ExportRecord, ExportValue } from './export-format';
export { csvHeader, EXPORT_EXTENSION, EXPORT_FORMATS, encodeExportPage } from './export-format';
export type { ExportManifest, ExportSink, MemoryExportSink } from './export-sink';
export {
  EXPORT_PART_DIGITS,
  exportManifestKey,
  exportPartKey,
  memoryExportSink,
} from './export-sink';
export { IDLE_POLL_CEILING_MS } from './idle-backoff';
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
export { pauseQueue, promoteJob, removeJob, resumeQueue } from './inspect-operator';
export type {
  BulkFilter,
  BulkResult,
  CounterBucketMs,
  CounterOutcome,
  CounterTotals,
  JobCounter,
  JobFilter,
  JobIntrospection,
  JobProgress,
  PausedName,
  TaskFire,
  WorkerAnnouncement,
  WorkerRecord,
} from './introspection';
export {
  COUNTER_BUCKET_MS,
  COUNTER_TIERS,
  DEFAULT_JOB_PAGE,
  jobCursor,
  MAX_BULK_ROWS,
  MAX_ERROR_STACK_LENGTH,
  MAX_JOB_PAGE,
  MAX_PROGRESS_NOTE_LENGTH,
  MAX_TASK_FIRES,
  MAX_WORKER_IN_FLIGHT,
  PROGRESS_INTERVAL_MS,
  PROMOTABLE_STATES,
} from './introspection';
export type {
  AnyJobHandle,
  JobActor,
  JobDefinition,
  JobHandle,
  JobRunArgs,
} from './job';
export { describeJobs, getJob, isJobHandle, job, registeredJobs, resetJobs } from './job';
export type { HeldLease, LeaseStore, MemoryLeaseStore, MemoryLeaseStoreOptions } from './leases';
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
  OutboxStore,
} from './outbox';
export {
  createJobsFacade,
  createMemoryOutboxStore,
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
export type { OutboxRelay, RelayOptions } from './outbox-relay';
export { createOutboxRelay } from './outbox-relay';
export type { ProgressFn } from './progress';
export type {
  PurgeDefinition,
  PurgeInput,
  PurgeReport,
  PurgeSweep,
  PurgeTarget,
} from './purge';
export { DEFAULT_PURGE_CRON, purge } from './purge';
export type { PgListener, QueueWake, QueueWakeOptions } from './queue-wake';
export { startQueueWake } from './queue-wake';
export type { IntervalScheduler } from './renewal-timer';
export type { BackoffStrategy, Random, RetryDecision, RetryPolicy } from './retry';
export { backoffDelayMs, DEFAULT_RETRY, isFinalAttempt, nextRetry, retrySchedule } from './retry';
export type { JobRetryDecision, JobStopReason } from './retry-classification';
export { classifyThrown, failureForRow, nextRetryForError } from './retry-classification';
export type {
  CronResolver,
  DispatchedOccurrence,
  Scheduler,
  SchedulerOptions,
} from './scheduler';
export {
  COUNTER_ROLLUP_INTERVAL_MS,
  createScheduler,
  PAUSE_RECHECK_MS,
} from './scheduler';
export type { LeaderElection } from './scheduler-leader';
export { soleLeader } from './scheduler-leader';
export { nextTaskRun } from './scheduler-occurrences';
export type { PgLeaseLeaderOptions } from './scheduler-pg';
export {
  createPgLeaseLeader,
  currentLeader,
  DEFAULT_LEADER_TTL_MS,
  LEASE_RENEWALS_PER_TTL,
  pgSchedulerState,
} from './scheduler-pg';
export type { ScheduledFire, SchedulerState } from './scheduler-state';
export { createMemorySchedulerState, fireThroughDriver } from './scheduler-state';
export type { JobCompleted, JobFailed, JobSettled } from './settled';
export { ON_SETTLED_ATTEMPTS } from './settled';
export type {
  EventLookup,
  StepApi,
  StepFence,
  StepRecord,
  StepRunner,
  StepRunnerOptions,
  StepStatus,
  StepStore,
  WaitForEventOptions,
} from './steps';
export {
  createStepRunner,
  isStepStatus,
  isStepSuspension,
  MAX_TRACE_NAMES,
  STEP_STATUSES,
  StepSuspension,
} from './steps';
export { createMemoryStepStore } from './steps-memory';
export type {
  CatchUpPolicy,
  TaskDefinition,
  TaskDescriptor,
  TaskEnqueueEntry,
  TaskHandle,
  TaskJobResult,
} from './task';
export { getTask, isTaskHandle, registeredTasks, resetTasks, restoreTasks, task } from './task';
/**
 * The tenant a job's body runs under. The TYPE only: `NO_JOB_TENANT`, `jobRunActor` and
 * `jobTenantFor` stay unexported. The first would be a second spelling of `'none'` (axiom 1 — the
 * literal is what the type says and what a declaration reads as), and the other two are
 * `executeJob`'s and `job()`'s: a second caller deriving a run's org would be a second answer to
 * "whose tenant is this", which is the thing this declaration exists to make singular.
 */
export type { JobTenant } from './tenant';
export type {
  WebhookDefinition,
  WebhookDeliveryInput,
  WebhookEndpoint,
  WebhookEvent,
  WebhookReport,
} from './webhook';
export { DEFAULT_WEBHOOK_DISABLE_AFTER, webhook } from './webhook';
export type { WebhookFetch } from './webhook-attempt';
export { WEBHOOK_CONTENT_TYPE } from './webhook-attempt';
export {
  WebhookDeliveryFailedError,
  WebhookDeliveryRejectedError,
  WebhookDeliveryThrottledError,
  WebhookEndpointDisabledError,
  WebhookEndpointInvalidError,
  WebhookEndpointUnknownError,
  WebhookEventInvalidError,
  WebhookEventUnknownError,
} from './webhook-errors';
export type { MemoryWebhookLedger, WebhookAttempt, WebhookLedger } from './webhook-ledger';
export { DEFAULT_MAX_WEBHOOK_ATTEMPTS, memoryWebhookLedger } from './webhook-ledger';
export type { Worker, WorkerOptions, WorkerStats } from './worker';
export { createWorker } from './worker';
