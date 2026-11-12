// Public API of @ultimat3/jobs. Explicit, no `export *`.
//
// `registerJob`/`registerJobs`/`registerTask`/`registerTasks`/`nameJobs`/`nameTasks` are
// deliberately absent. `defineApi({ jobs, tasks })` is where a module is handed over and nothing
// else registers (CLAUDE.md); it reaches them through core's registrar table, which the
// side-effect import below fills. Exporting them would offer a second registration path that
// bypasses `defineApi`'s own result — the ambiguity axiom 1 exists to refuse.
import './register';

// The webhook wire format (`WEBHOOK_*`, `webhookSignature`, `webhookMac`, …) is `@ultimat3/core`'s
// and imported from there: one module at the tier this package (the signer) and `@ultimat3/http`
// (the verifier) both reach, with one import path — never re-exported here (`X_HELPER_COPY`).
export type { PgExecutor } from '@ultimat3/core';
/** Re-exported so a `job`/`task` file needs one import, not two. Same object as schema's. */
export type { Infer } from '@ultimat3/schema';
export { t } from '@ultimat3/schema';
export type {
  BackfillBatch,
  BackfillDefinition,
  BackfillInput,
  BackfillPage,
  BackfillPages,
  ScopedBackfillDefinition,
  ScopedBackfillInput,
} from './backfill';
export { backfill, DEFAULT_BACKFILL_BATCH } from './backfill';
export {
  BackfillPendingError,
  BackfillRunningError,
  BackfillUnknownError,
} from './backfill-errors';
export type { BackfillGate, BackfillGateInput } from './backfill-gate';
export { gateBackfill } from './backfill-gate';
export type { BackfillProgress } from './backfill-inspect';
export { inspectBackfills, toBackfillProgress } from './backfill-inspect';
export type {
  BackfillFilter,
  BackfillLedger,
  BackfillRun,
  BackfillStatus,
} from './backfill-ledger';
export {
  BACKFILL_STATUSES,
  backfillChecksum,
  isBackfillStatus,
  memoryBackfillLedger,
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
export { backfillPacer, DEFAULT_BACKFILL_RATE } from './backfill-rate';
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
export type { JobConcurrency, KeyedConcurrency } from './concurrency';
export { consumer } from './consumer';
export { CONSUMER_LINGER_MS } from './consumer-loop';
// `stampConsumer` is deliberately absent, for the reason `stampBackfill` is.
export type { ConsumerDeclaration, ConsumerRow } from './consumer-registry';
export { consumerRow, registeredConsumers } from './consumer-registry';
export type {
  ConsumerCursor,
  ConsumerDefinition,
  ConsumerHandle,
  ConsumerInput,
} from './consumer-types';
export type { JobConcurrencyDescriptor, JobDescriptor } from './describe';
export type {
  ClaimedJob,
  ClaimIdentity,
  ClaimOptions,
  ConflictPolicy,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  JobRecord,
  JobState,
  NackOptions,
  QueueDemand,
  QueueStats,
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
} from './driver';
export type { MemoryJobDriver, MemoryJobDriverOptions } from './driver-memory';
export { memoryJobDriver } from './driver-memory';
export type { PostgresJobDriverOptions } from './driver-pg';
export { postgresJobDriver, postgresLeader } from './driver-pg';
// Only the statement another workspace runs: the install (`cli/src/framework-schema.ts`, action,
// notify), and the storage it renders, which that install's drift check reads. The rest are this
// package's internals, read where they are defined, and tested there too — the array-parameter
// proofs are `driver-pg-array.live.test.ts` (25.0.0).
export { JOBS_TABLE_STORAGE } from './driver-pg-ddl';
export { SQL_JOBS_TABLE } from './driver-pg-sql';
export { signalEnqueued, signalStaged } from './enqueue-signal';
export type { JobErrorCode } from './error-codes';
export { JOB_ERROR_CODES, JOB_ERROR_TITLES } from './error-codes';
export {
  DriverUnavailableError,
  JobAbortedError,
  JobDrainedError,
  JobDuplicateError,
  JobNotCancellableError,
  JobTimeoutError,
  LeaseLostError,
} from './errors';
export { ConcurrencyUnenforceableError, JobKeyBusyError } from './errors-concurrency';
export { JobNotFoundError } from './errors-requeue';
export { COMPENSATE_PREFIX, StepNameReservedError, UNWINDING_STEP } from './errors-saga';
export { JobTenantMismatchError } from './errors-tenant';
export type { EventBus, JobEvent, MemoryEventBusOptions, PublishOptions } from './events';
export {
  EVENTS_PURGE_TARGET,
  eventBus,
  eventsPurgeTarget,
  memoryEventBus,
  publishEvent,
} from './events';
export type { PostgresEventBusOptions } from './events-pg';
export { postgresEventBus } from './events-pg';
export type { ExecuteJobOptions } from './execute';
export { executeJob } from './execute';
export type { JobExecution, JobOutcome } from './execute-result';
export type { ExportDefinition } from './export';
export { exportRows } from './export';
export type { EncodePageInput, ExportValue } from './export-format';
export { EXPORT_FORMATS, encodeExportPage } from './export-format';
export type { ExportSink, MemoryExportSink } from './export-sink';
export { memoryExportSink } from './export-sink';
export type { CallerFailure } from './failure-row';
export { callerFailure } from './failure-row';
export { personalDataProblems, unerasedPersonalData, unreachedPersonalData } from './gdpr-coverage';
export { PersonalDataUnerasedError, PersonalDataUnreachedError } from './gdpr-errors';
export { IDLE_POLL_CEILING_MS } from './idle-backoff';
export type { ImportDefinition } from './import';
export { importRows } from './import';
export { IMPORT_REJECTIONS } from './import-format';
export { importErrorKey } from './import-pass';
export type { ImportSource, MemoryImportSource } from './import-source';
export { memoryImportSource } from './import-source';
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
export {
  pauseQueue,
  promoteJob,
  removeJob,
  resolveJobStep,
  resumeQueue,
} from './inspect-operator';
export type {
  BulkFilter,
  BulkResult,
  CounterBucketMs,
  CounterTotals,
  JobCounter,
  JobFilter,
  JobIntrospection,
  JobProgress,
  PausedName,
  StepResolution,
  TaskFire,
  WorkerAnnouncement,
  WorkerRecord,
} from './introspection';
export {
  COUNTER_TIERS,
  DEFAULT_JOB_PAGE,
  jobCursor,
  MAX_BULK_ROWS,
  MAX_JOB_PAGE,
  MAX_TASK_FIRES,
  PROMOTABLE_STATES,
} from './introspection';
export type { AnyJobHandle, JobDefinition, JobHandle, JobRunArgs } from './job';
export {
  describeJobs,
  getJob,
  isJobHandle,
  job,
  registeredJobs,
  resetJobs,
  restoreJobs,
} from './job';
export type { EnqueueManyOptions } from './job-enqueue-many';
export { MAX_ENQUEUE_BATCH } from './job-enqueue-many';
export type { JobsRetentionOptions } from './jobs-retention';
export { jobsPurgeTarget } from './jobs-retention';
export type { HeldLease, LeaseStore, MemoryLeaseStore, MemoryLeaseStoreOptions } from './leases';
export { jobLeaseKey, memoryLeaseStore } from './leases';
export type { LedgerDefinition, LedgerEntry, LedgerPosting } from './ledger';
export { assertBalancedPosting, ledger, ledgerLines } from './ledger';
export type { EntityLedgerBookOptions, LedgerBook, LedgerLine } from './ledger-book';
export { entityLedgerBook } from './ledger-book';
export type { Lease, LimitConfig, Limiter, LimitSnapshot, RateLimit } from './limits';
export { concurrencyLimiter, NO_TENANT } from './limits';
export type { HeldLock, WithLockOptions } from './lock';
export { withLock } from './lock';
export { queueDemand, recordQueueDemand } from './metrics';
export type {
  EnqueueOptions,
  JobsFacade,
  MemoryOutboxStore,
  MemoryOutboxStoreOptions,
  OutboxDeps,
  OutboxRecord,
  OutboxStore,
} from './outbox';
export {
  jobsFacade,
  memoryOutboxStore,
  outboxJobsFacade,
  resetJobsFacade,
  setJobsFacade,
} from './outbox';
// One definition of the lease, consumed by both stores — a memory default and a pg default that
// could drift are two answers to "how long is a claim mine for", and the shorter one duplicates.
export { DEFAULT_OUTBOX_CLAIM_LEASE_MS } from './outbox-lease';
export type { PostgresOutboxStoreOptions } from './outbox-pg';
export { postgresOutboxStore } from './outbox-pg';
export type { OutboxRelay, RelayOptions } from './outbox-relay';
export { outboxRelay } from './outbox-relay';
export type { OutboxRetentionOptions } from './outbox-retention';
export { outboxPurgeTarget } from './outbox-retention';
export type { PartitionsDefinition, PartitionsJob } from './partitions';
export { partitionedEntities, partitions } from './partitions';
export type { ProgressFn } from './progress';
export type {
  PurgeDefinition,
  PurgeInput,
  PurgeReport,
  PurgeSweep,
  PurgeTarget,
} from './purge';
export { DEFAULT_PURGE_CRON, purge } from './purge';
export type { PurgeBatching } from './purge-batches';
export type { PurgeEntities } from './purge-entities';
export { resetPurgeCoverage, retainTarget, unsweptEntities } from './purge-entities';
export type { PgListener, QueueWake, QueueWakeOptions } from './queue-wake';
export { startQueueWake } from './queue-wake';
export type { RefreshViewDefinition } from './refresh-view';
export { refreshView } from './refresh-view';
export type { ReindexDefinition } from './reindex';
export { reindex } from './reindex';
export type { IntervalScheduler } from './renewal-timer';
export type { BackoffStrategy, Random, RetryDecision, RetryPolicy } from './retry';
export {
  backoffDelayMs,
  DEFAULT_RETRY,
  enqueuedAttempts,
  isFinalAttempt,
  isUnwindAttempt,
  nextRetry,
  retrySchedule,
  UNWIND_MARGIN,
} from './retry';
export type { JobRetryDecision, JobStopReason } from './retry-classification';
export { nextRetryForError } from './retry-classification';
export type { RollupBucket, RollupDefinition, RollupInput, RollupTarget } from './rollup';
export { rollup } from './rollup';
export type { CronResolver, Scheduler, SchedulerOptions } from './scheduler';
export { COUNTER_ROLLUP_INTERVAL_MS, jobScheduler } from './scheduler';
export type { LeaderElection } from './scheduler-leader';
export { soleLeader } from './scheduler-leader';
export { nextTaskRun } from './scheduler-occurrences';
export type { PostgresLeaseLeaderOptions } from './scheduler-pg';
export { DEFAULT_LEADER_TTL_MS, postgresLeaseLeader, postgresSchedulerState } from './scheduler-pg';
export type { ScheduledFire, SchedulerState } from './scheduler-state';
export { memorySchedulerState } from './scheduler-state';
export type { JobCompleted, JobFailed, JobSettled } from './settled';
export { ON_SETTLED_ATTEMPTS, ON_SETTLED_TIMEOUT_MS } from './settled';
export { currentStep } from './step-scope';
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
  DEFAULT_EVENT_POLL_MS,
  isStepStatus,
  isStepSuspension,
  MAX_TRACE_NAMES,
  STEP_STATUSES,
  StepSuspension,
  stepRunner,
  WAKING_EVENT_POLL_MS,
} from './steps';
export { memoryStepStore } from './steps-memory';
export type { StepOutput } from './steps-output';
export type {
  RetainedTarget,
  Subject,
  SubjectInit,
  SubjectTarget,
  SubjectTargetEntry,
  SubjectTreatment,
} from './subject';
export { defineSubject, registeredSubjects, resetSubjects } from './subject';
export type { SubjectEraseReport, SubjectTally } from './subject-erase-pass';
export type { SubjectExportDefinition, SubjectJobDefinition } from './subject-jobs';
export { subjectErase, subjectEraseTables, subjectExport } from './subject-jobs';
export type {
  SubjectPlan,
  SubjectPlanInput,
  SubjectStep,
  SubjectUnlink,
  SubjectVia,
} from './subject-plan';
export { planSubject } from './subject-plan';
export type {
  CatchUpPolicy,
  TaskDefinition,
  TaskDescriptor,
  TaskEnqueueEntry,
  TaskHandle,
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
  WebhookTenant,
} from './webhook';
export { DEFAULT_WEBHOOK_DISABLE_AFTER, webhook } from './webhook';
export type { WebhookFetch } from './webhook-attempt';
export type { MemoryWebhookLedger, WebhookAttempt, WebhookLedger } from './webhook-ledger';
export { memoryWebhookLedger } from './webhook-ledger';
export { webhookReceiver, webhookReceiverRoutes } from './webhook-receiver';
export { WEBHOOK_EVENT_ID_PATTERN } from './webhook-receiver-errors';
export type {
  ReceivedEventFacts,
  WebhookReceiver,
  WebhookReceiverDefinition,
  WebhookReceiverInput,
  WebhookReceiverTenant,
} from './webhook-receiver-types';
export type { Worker, WorkerOptions, WorkerStats } from './worker';
export { jobWorker } from './worker';
export type { CutoffTimes } from './worker-drain-cutoff';
export { cutoffTimes, DRAIN_CANCEL_MARGIN_MS } from './worker-drain-cutoff';
