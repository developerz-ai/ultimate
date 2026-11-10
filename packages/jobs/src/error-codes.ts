// The X_* codes owned by @ultimat3/jobs, and nothing else: the two lists, their titles, the one
// registration call and the retry classification. `bun run new-error-code --package jobs` writes
// here. The classes that throw these codes live in `./errors`, which imports this file for its
// registration, so a module that can construct one of them has the code registered.
import { registerErrorCodes, registerErrorRetry } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const JOB_OWNED_ERROR_CODES = [
  'X_JOB_DUPLICATE',
  'X_STEP_DUPLICATE',
  'X_JOB_TIMEOUT',
  'X_JOB_MAX_ATTEMPTS',
  'X_DRIVER_UNAVAILABLE',
  'X_IDEMPOTENCY_REQUIRED',
  'X_JOB_TENANT_REQUIRED',
  'X_JOB_CONCURRENCY_UNENFORCEABLE',
  'X_JOB_LEASE_LOST',
  'X_JOB_SLOT_LOST',
  'X_JOB_NOT_CANCELLABLE',
  'X_OUTBOX_NO_TX',
  'X_BACKFILL_PENDING',
  'X_BACKFILL_APPLIED',
  'X_BACKFILL_ENVIRONMENT',
  'X_BACKFILL_MIGRATION_PENDING',
  'X_BACKFILL_RUNNING',
  'X_BACKFILL_STALLED',
  'X_BACKFILL_UNKNOWN',
  'X_JOB_ROW_STATUS_UNKNOWN',
  'X_ACTION_JOB_UNBRIDGED',
  'X_JOB_CLAIM_QUEUES_EMPTY',
  'X_WEBHOOK_ENDPOINT_UNKNOWN',
  'X_WEBHOOK_ENDPOINT_INVALID',
  'X_WEBHOOK_ENDPOINT_DISABLED',
  'X_WEBHOOK_EVENT_UNKNOWN',
  'X_WEBHOOK_EVENT_INVALID',
  'X_WEBHOOK_DELIVERY_FAILED',
  'X_WEBHOOK_DELIVERY_THROTTLED',
  'X_WEBHOOK_DELIVERY_REJECTED',
  'X_EXPORT_ROW_INVALID',
  'X_EXPORT_PART_TOO_LARGE',
  'X_JOB_DECLARATION_INVALID',
  'X_JOB_NOT_REQUEUEABLE',
  'X_JOB_KEY_BUSY',
  'X_JOB_NOT_REMOVABLE',
  'X_JOB_NOT_PROMOTABLE',
  'X_JOB_PAGE_INVALID',
  'X_JOB_ON_SETTLED_FAILED',
  'X_JOB_NOT_FOUND',
  'X_JOB_TENANT_MISMATCH',
  'X_STEP_OUTPUT_UNSERIALIZABLE',
  'X_JOB_EVENT_INVALID',
  'X_IMPORT_HEADER_MISMATCH',
  'X_IMPORT_RECORD_TOO_LARGE',
  'X_IMPORT_TOO_MANY_ERRORS',
  'X_JOB_ENQUEUE_BATCH_TOO_LARGE',
  'X_WEBHOOK_RECEIVER_INVALID',
  'X_WEBHOOK_RECEIVER_UNAVAILABLE',
  'X_WEBHOOK_EVENT_ID_INVALID',
  'X_JOB_COMPENSATION_FAILED',
  'X_STEP_OUTCOME_UNKNOWN',
  'X_CONSUMER_INVALID',
  'X_CONSUMER_SELF_ENQUEUE',
  'X_BACKFILL_SOURCE_INVALID',
  'X_STEP_NOT_RESOLVABLE',
  'X_JOB_ROLLUP_INVALID',
  'X_JOB_REFRESH_VIEW_INVALID',
  'X_SUBJECT_TABLE_UNDECLARED',
  'X_SUBJECT_TREATMENT_INVALID',
  'X_SUBJECT_CYCLE',
  'X_LOCK_NOT_ACQUIRED',
  'X_LOCK_LOST',
  'X_LOCK_STORE_MISSING',
  'X_LEDGER_UNBALANCED',
  'X_LEDGER_ENTRY_INVALID',
  'X_PERSONAL_DATA_UNERASED',
  'X_PERSONAL_DATA_UNREACHED',
  'X_LEDGER_POSTING_CONFLICT',
] as const;

/**
 * `X_NOT_IMPLEMENTED`, `X_ABORTED` and `X_DRAINING` are `@ultimat3/core`'s. The first is thrown as
 * core's own `NotImplementedError` (`inspect.ts`), the other two by
 * `JobAbortedError` and `JobDrainedError` below; jobs keeps no title for any of the three, because the copy this file used to hold was a second title that nothing would have failed
 * on once core's changed. Listed here all the same, so `JobErrorCode` can name every code a job
 * can see — `X_DRAINING` was thrown for a day before it was, and the type said it could not be.
 */
export const JOB_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED', 'X_ABORTED', 'X_DRAINING'] as const;

/** Every code jobs can throw: the ones it owns plus the ones it borrows. */
export const JOB_ERROR_CODES = [...JOB_OWNED_ERROR_CODES, ...JOB_BORROWED_ERROR_CODES] as const;

export type JobOwnedErrorCode = (typeof JOB_OWNED_ERROR_CODES)[number];
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export const JOB_ERROR_TITLES: Readonly<Record<JobOwnedErrorCode, string>> = {
  X_JOB_DUPLICATE: 'a live key already has a job',
  X_STEP_DUPLICATE: 'two step.run calls share a name',
  X_JOB_TIMEOUT: 'a job exceeded its wall-clock limit',
  X_JOB_MAX_ATTEMPTS: 'the job exhausted its retries',
  X_DRIVER_UNAVAILABLE: 'the queue driver is unreachable',
  X_IDEMPOTENCY_REQUIRED: 'the job has no idempotencyKey',
  X_JOB_TENANT_REQUIRED: 'the job declares no tenant',
  X_JOB_CONCURRENCY_UNENFORCEABLE: 'job.concurrency is declared and cannot be enforced',
  X_JOB_LEASE_LOST: 'the queue took this job back mid-run',
  X_JOB_SLOT_LOST: 'the fleet concurrency slot was taken by another worker',
  X_JOB_NOT_CANCELLABLE: 'the job cannot be cancelled',
  X_OUTBOX_NO_TX: 'enqueue outside a transaction',
  X_BACKFILL_PENDING: 'a declared backfill has never completed',
  X_BACKFILL_APPLIED: 'the ledger already holds a completed pass',
  X_BACKFILL_ENVIRONMENT: 'the backfill is not declared for this environment',
  X_BACKFILL_MIGRATION_PENDING: 'the migration this backfill requires is not applied',
  X_BACKFILL_RUNNING: 'a pass under this name is already live',
  X_BACKFILL_STALLED: 'the sweep ended with rows its own count still matches',
  X_BACKFILL_UNKNOWN: 'no declaration carries this backfill name',
  X_JOB_ROW_STATUS_UNKNOWN: 'a queue row carries a status this build does not know',
  X_ACTION_JOB_UNBRIDGED: 'an action projection was registered as a job',
  X_JOB_CLAIM_QUEUES_EMPTY: 'a claim named no queue, and the drivers do not agree what that means',
  X_WEBHOOK_ENDPOINT_UNKNOWN: 'no endpoint carries this id',
  X_WEBHOOK_ENDPOINT_INVALID: 'the endpoint cannot be delivered to as declared',
  X_WEBHOOK_ENDPOINT_DISABLED: 'the endpoint takes no deliveries',
  X_WEBHOOK_EVENT_UNKNOWN: 'no event carries this id',
  X_WEBHOOK_EVENT_INVALID: 'the event cannot be signed as declared',
  X_WEBHOOK_DELIVERY_FAILED: 'the endpoint did not accept the delivery',
  X_WEBHOOK_DELIVERY_THROTTLED: 'the endpoint asked for the delivery later, and said when',
  X_WEBHOOK_DELIVERY_REJECTED: 'the endpoint refused the delivery in a way a retry cannot change',
  X_EXPORT_ROW_INVALID: 'row() answered something the declared columns do not carry',
  X_EXPORT_PART_TOO_LARGE: 'one page encoded to more bytes than a part may hold',
  X_JOB_DECLARATION_INVALID: 'the job declaration is missing or mis-declares a field',
  X_JOB_NOT_REQUEUEABLE: 'the job is still live and cannot be requeued',
  X_JOB_KEY_BUSY: 'the concurrency key already holds its limit of runs',
  X_JOB_NOT_REMOVABLE: 'the job is running and cannot be removed',
  X_JOB_NOT_PROMOTABLE: 'the job is not waiting on its run time',
  X_JOB_PAGE_INVALID: 'a job list page was asked for outside its bounds',
  X_JOB_ON_SETTLED_FAILED: 'the onSettled hook failed after the run was settled',
  X_JOB_NOT_FOUND: 'the queue holds no job with this id',
  X_JOB_TENANT_MISMATCH: "a job's payload names an org other than the tenant it runs under",
  X_STEP_OUTPUT_UNSERIALIZABLE: 'a step returned a value JSON cannot hold',
  X_JOB_EVENT_INVALID: 'a waited event failed its schema',
  X_IMPORT_HEADER_MISMATCH: 'the csv header does not name the declared columns',
  X_IMPORT_RECORD_TOO_LARGE: 'one record runs past the bytes a record may hold',
  X_IMPORT_TOO_MANY_ERRORS: 'more rows were rejected than the import allows',
  X_JOB_ENQUEUE_BATCH_TOO_LARGE: 'enqueueMany was handed more inputs than one call may stage',
  X_WEBHOOK_RECEIVER_INVALID: 'a webhookReceiver() declaration cannot be served',
  X_WEBHOOK_RECEIVER_UNAVAILABLE:
    'an inbound webhook could not be queued, so it was not acknowledged',
  X_WEBHOOK_EVENT_ID_INVALID:
    'the event id a webhook receiver verified is not one it can key a job by',
  X_JOB_COMPENSATION_FAILED: 'a compensator could not undo its step',
  X_STEP_OUTCOME_UNKNOWN: 'a once step started and never completed',
  X_CONSUMER_INVALID: 'a consumer() declaration cannot be run as declared',
  X_CONSUMER_SELF_ENQUEUE: 'a consumer enqueued itself from inside its own run',
  X_BACKFILL_SOURCE_INVALID:
    'a backfill() declares both or neither of source and pages, or input with no scope',
  X_STEP_NOT_RESOLVABLE: 'the step is not an unknown once outcome an operator can resolve',
  X_JOB_ROLLUP_INVALID: 'a rollup declaration cannot be run',
  X_JOB_REFRESH_VIEW_INVALID: 'a refreshView declaration names no materialized view it can refresh',
  X_SUBJECT_TABLE_UNDECLARED:
    'a table reaches the declared subject and defineSubject gives it no treatment',
  X_SUBJECT_TREATMENT_INVALID: 'a defineSubject treatment cannot be carried out',
  X_SUBJECT_CYCLE: 'the subject erase has no deletion order',
  X_LOCK_NOT_ACQUIRED: 'withLock could not take the lock within its wait bound',
  X_LOCK_LOST: 'a lock withLock held expired before its work finished',
  X_LOCK_STORE_MISSING: 'withLock found no lease store to hold the lock in',
  X_LEDGER_UNBALANCED: 'a ledger posting does not sum to zero in every currency',
  X_LEDGER_ENTRY_INVALID: 'a ledger entry is not a whole-minor Money amount on a named account',
  X_PERSONAL_DATA_UNERASED:
    'a subject erase would leave a personalData() column of a reached table',
  X_PERSONAL_DATA_UNREACHED: 'an entity carries personalData() columns no declared subject reaches',
  X_LEDGER_POSTING_CONFLICT: 'a ledger posting key is already stored with other entries',
};

// One unconditional call, so a second package claiming one of jobs' codes throws
// X_ERROR_CODE_DUPLICATE instead of losing silently to whichever module imported first.
registerErrorCodes(
  Object.fromEntries(Object.entries(JOB_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The codes of this package's that can be thrown INSIDE a job body, classified — `executeJob`
 * reads this, so a `terminal` one dead-letters on the attempt it happened instead of spending the
 * whole policy on an answer that cannot change. Same rule every package uses: retryable means the
 * same code, run again, has a real chance of a different answer.
 *
 * Two are deliberately absent. `X_JOB_LEASE_LOST` and `X_JOB_SLOT_LOST` mean the row is somebody
 * else's now, so this attempt's verdict is not this attempt's to give: dead-lettering would settle
 * a job another worker is running. They keep the attempt-count path, which ends in the queue
 * re-delivering — the honest outcome for "we stopped owning it".
 */
registerErrorRetry({
  X_JOB_TIMEOUT: 'retryable',
  X_DRIVER_UNAVAILABLE: 'retryable',
  // A second `step.run` under one name is a defect in the handler, replayed identically forever.
  X_STEP_DUPLICATE: 'terminal',
  // A sweep whose source ran dry while its own count still matches rows: the next attempt resumes
  // at the cursor that just ran dry and diverges again.
  X_BACKFILL_STALLED: 'terminal',
  X_BACKFILL_ENVIRONMENT: 'terminal',
  X_BACKFILL_APPLIED: 'terminal',
  // The one retryable webhook code, and the reason the split exists at all: a 5xx, a 429 or a
  // connection that never opened is the same request landing later, which is what the job's retry
  // policy is for.
  X_WEBHOOK_DELIVERY_FAILED: 'retryable',
  // `retry-after` and not `retryable`: the receiver NAMED a delay, so `statedDelayMs` reads
  // `meta.retryAfterSeconds` and the nack waits that long (clamped by the policy's `maxDelay`)
  // instead of guessing a curve against an answer it was already given.
  X_WEBHOOK_DELIVERY_THROTTLED: 'retry-after',
  // The rest are `terminal` and every one is LISTED rather than left to the default, because
  // `classifyThrown` reads an unregistered code carrying `terminal` as UNCLASSIFIED — which spends
  // a delivery's whole retry policy re-proving that a 404 endpoint is still a 404.
  X_WEBHOOK_DELIVERY_REJECTED: 'terminal',
  X_WEBHOOK_ENDPOINT_UNKNOWN: 'terminal',
  X_WEBHOOK_ENDPOINT_INVALID: 'terminal',
  X_WEBHOOK_ENDPOINT_DISABLED: 'terminal',
  X_WEBHOOK_EVENT_UNKNOWN: 'terminal',
  X_WEBHOOK_EVENT_INVALID: 'terminal',
  // Both export codes are refusals of the DECLARATION and not of the data: the same `row()` over
  // the same page answers the same way on every attempt, so an unclassified reading would spend
  // the whole retry policy proving it.
  X_EXPORT_ROW_INVALID: 'terminal',
  X_EXPORT_PART_TOO_LARGE: 'terminal',
  // An import reads the same bytes on every attempt: a header, an unclosed quote and a count of
  // refused rows answer identically, so the repair is the file and a new enqueue, never a retry.
  X_IMPORT_HEADER_MISMATCH: 'terminal',
  X_IMPORT_RECORD_TOO_LARGE: 'terminal',
  X_IMPORT_TOO_MANY_ERRORS: 'terminal',
  // The worker settles a busy key itself; listed so a body that RETHROWS one it was handed stops.
  X_JOB_KEY_BUSY: 'terminal',
  // The payload names the wrong org, or none its tenant can run under — a fact about the ROW, so
  // every attempt and every `x jobs retry` is refused identically: the repair is a new enqueue.
  X_JOB_TENANT_MISMATCH: 'terminal',
  // The same value is refused on attempt five; the step's side effect has already happened.
  X_STEP_OUTPUT_UNSERIALIZABLE: 'terminal',
  // The stored event is the same on every attempt: the repair is the publisher or the schema.
  X_JOB_EVENT_INVALID: 'terminal',
  // The same list is the same length on every attempt: the repair is the caller's slicing.
  X_JOB_ENQUEUE_BATCH_TOO_LARGE: 'terminal',
  // A step name the framework reserves, or `compensate` on a job without `compensates: true`: the
  // body is the same on every attempt, so the repair is the declaration.
  X_JOB_DECLARATION_INVALID: 'terminal',
  // Only a person or the vendor can say whether a `once` step ran (`x jobs resolve-step`).
  X_STEP_OUTCOME_UNKNOWN: 'terminal',
  // The unwind's own attempts are spent, or it met an unknown `once` step: the repair is a person.
  X_JOB_COMPENSATION_FAILED: 'terminal',
  // The body that enqueued itself does so on every attempt: the repair is deleting the call.
  X_CONSUMER_SELF_ENQUEUE: 'terminal',
  // A subject's plan is read off the declarations: the same entities plan the same way every time.
  X_SUBJECT_TABLE_UNDECLARED: 'terminal',
  X_SUBJECT_TREATMENT_INVALID: 'terminal',
  X_SUBJECT_CYCLE: 'terminal',
  // A posting is the job's input: the same entries are refused on every attempt.
  X_LEDGER_UNBALANCED: 'terminal',
  X_LEDGER_ENTRY_INVALID: 'terminal',
  // A stored posting does not change between attempts: the repair is a new key.
  X_LEDGER_POSTING_CONFLICT: 'terminal',
  // No store is a wiring fact; contention (`X_LOCK_NOT_ACQUIRED`) and a lost lock stay retryable.
  X_LOCK_STORE_MISSING: 'terminal',
  // Read off the declarations, as the `X_SUBJECT_*` refusals are: the same every attempt.
  X_PERSONAL_DATA_UNERASED: 'terminal',
  X_PERSONAL_DATA_UNREACHED: 'terminal',
});
