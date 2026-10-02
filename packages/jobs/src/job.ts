// The `job` primitive: durable background work. The shape is the contract's shape exactly.
//
// `idempotencyKey` is NON-OPTIONAL in the type. Queues deliver at least once — network
// partitions, visibility-timeout expiry and outbox relays all replay — so "did this already
// run?" is a question every job must answer. Making it optional means the answer is usually
// "nobody thought about it", and the bug (two charges, two welcome emails, two provisioned
// orgs) surfaces in production under load, never in a test. Requiring it by construction
// deletes that class of bug: there is no way to define a job that cannot be deduped.

import type { Ctx } from '@ultimat3/core';
import { assert, finiteCount } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { finiteDurationMs } from './clock';
import type { JobConcurrency, WhenBusy } from './concurrency';
import { resolveConcurrency } from './concurrency';
import type { JobDescriptor } from './describe';
import { describeJob } from './describe';
import type { EnqueueResult } from './driver';
import { DEFAULT_QUEUE } from './driver';
import { IdempotencyRequiredError, JobNameTakenError } from './errors';
import { JobDeclarationInvalidError } from './errors-declaration';
import { NO_TENANT, tenantKeyFrom } from './limits';
import type { EnqueueOptions } from './outbox';
import { jobsFacade } from './outbox';
import type { ProgressFn } from './progress';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { JobSettled } from './settled';
import type { StepApi } from './steps';
import type { JobTenant } from './tenant';
import { assertJobTenant, jobTenantFor } from './tenant';

export interface JobRunArgs<I> {
  readonly input: I;
  readonly step: StepApi;
  /**
   * `ctx.signal` aborts when this attempt's `timeout` passes — the same seam an action reads, so
   * `throwIfAborted(ctx)` and `fetch(url, { signal: ctx.signal })` work here unchanged. Past it
   * the run belongs to whoever claims it next and `step.run` refuses to write, so a loop that
   * never checks it is a body running beside its own retry.
   */
  readonly ctx: Ctx;
  /** 1-based. Assume at-least-once: never branch on `attempt === 1` for correctness. */
  readonly attempt: number;
  /**
   * True when a failure of THIS attempt is not retried for want of attempts — the same boolean
   * the runner dead-letters on (`isFinalAttempt` in `retry.ts`), so a body never re-derives it
   * from `retry.attempts`. The place to release what a retry would have reused. REQUIRED: a test
   * that drives a body by hand states it, `isFinalAttempt(handle.retry, attempt)` being the
   * runner's own answer.
   *
   * Not "this body runs once more at most": a `terminal` error stops an earlier attempt, and an
   * attempt handed back UNCOUNTED — a `step.sleep`, a drain — is presented again under the same
   * number, so the last attempt of a job that sleeps sees `true` on every resume.
   */
  readonly finalAttempt: boolean;
  /**
   * `progress(done, total, note?)` — how far this run has got, shown by `x jobs show` and the
   * dashboard. Call it as often as the loop turns: it is written to the row at most once a
   * second, and the last call before the run settles is always written.
   */
  readonly progress: ProgressFn;
  readonly jobId: string;
  readonly runId: string;
}

export interface JobDefinition<I, R = unknown> {
  /**
   * Omit it: `defineApi({ jobs })` assigns the export name. Set it only to pin a queue key the
   * export name must not decide — a framework job like `mail.send`, or a name rows already carry.
   */
  readonly name?: string;
  readonly input: StandardSchemaV1<unknown, I>;
  /** REQUIRED. See the file header — this is the whole point. */
  readonly idempotencyKey: (input: I) => string;
  /**
   * REQUIRED, and the org this job's body runs under. `tenant: (input) => input.orgId` derives it
   * from the payload; `tenant: 'none'` says this job belongs to no tenant, and then every
   * tenant-scoped read inside it fails closed with `X_TENANCY_ACTOR_ORG_REQUIRED`.
   *
   * There is no default, because both candidates are wrong. Until this field existed the worker ran
   * a body with no ambient context at all, so `@ultimat3/entity`'s tenant guard — which derives
   * from `tryUseContext()` and not from the ctx it is handed — read no actor, added no predicate
   * and accepted a caller-named `orgId` unchecked: the same write refused over HTTP as
   * `X_TENANCY_ACTOR_MISMATCH` was ACCEPTED through the job surface. A boot-supplied service actor
   * would close that with ONE identity for every job, which is a cross-tenant read waiting for the
   * first job that takes an org id in its input. So the job declares it, per job, from its own
   * payload — the value an author already had to pass anyway.
   */
  readonly tenant: JobTenant<I>;
  readonly retry: RetryPolicy;
  readonly queue?: string;
  /**
   * Max in-flight runs of THIS job across the fleet. Omit for the queue-wide cap.
   *
   * A number is one cap for the job. `{ key, limit, whenBusy }` is that cap PER KEY — "one run
   * per account" — and says what a claim over it does: `'wait'` (default) leaves the run queued,
   * `'fail'` settles it `failed` with `X_JOB_KEY_BUSY` without running its body (`concurrency.ts`).
   *
   * Enforced by `JobDriver.leases` — a row every replica can see — and NOT by `limits.ts`, which
   * counts one process's heap. A driver with no lease store cannot hold this cap, so
   * `createWorker().start()` refuses to boot rather than let it pass silently
   * (`X_JOB_CONCURRENCY_UNENFORCEABLE`): this field was declared, documented and in the manifest
   * while nothing read it, which is exactly what axiom 3 exists to prevent.
   */
  readonly concurrency?: JobConcurrency<I>;
  readonly timeout?: DurationInput;
  /**
   * Ceiling for ONE `step.run`, where `timeout` is the ceiling for the whole attempt. Folded into
   * the signal the step body is handed, so a body reads one signal and sees whichever deadline
   * lands first — and it ABORTS before it rejects, because the attempt that replaces this one is
   * claimable the moment the nack lands.
   *
   * Declared here and nowhere else: the runner has implemented this ceiling since 1.0 and no
   * declaration could ask for it, which is a documented guarantee that does nothing.
   */
  readonly stepTimeout?: DurationInput;
  /**
   * How long a `step.waitForEvent` parks between polls. Default 30s. Lower it for a wait a user
   * is watching; the step suspends for exactly this long each time, so it is also the resolution
   * of the resume, never a busy loop.
   */
  readonly eventPoll?: DurationInput;
  run(args: JobRunArgs<I>): Promise<R>;
  /**
   * How the run ENDED, once: `completed` with what `run` returned, `dead-lettered`, `dropped`
   * (`retry.deadLetter: false`) or `refused` (`whenBusy: 'fail'` over a busy key — the body never
   * ran). Called after the row is settled, by the worker whose settle landed, under the job's
   * tenant. Not called for a retry, a suspension, a drain, or a row an operator cancelled.
   *
   * AT MOST ONCE across a crash: a worker killed between the settle and this call never makes it.
   * In one process it gets `ON_SETTLED_ATTEMPTS` tries; if all throw, the failure is logged and
   * reported (`X_JOB_ON_SETTLED_FAILED`) and the row is untouched. What must be recorded for
   * certain belongs in the body, inside a `step.run`.
   */
  onSettled?(settled: JobSettled<I, R>): Promise<void>;
}

/**
 * Whoever the enqueue is for. Structural, exactly like `tenantKeyFrom` in `limits.ts`: the
 * queue needs the actor's org and nothing else, so this package never imports the auth types.
 */
export interface JobActor {
  readonly orgId?: string | undefined;
  /**
   * The actor's id, recorded as `enqueuedBy` — ATTRIBUTION, never authority.
   *
   * The framework picks one answer to "whose permissions does a job run with" (axiom 1) and it is
   * this: a job body runs with SYSTEM authority and this is an audit column. Impersonating the
   * enqueuer at claim time is the defensible alternative and is rejected for one reason — a job
   * that sleeps three days, or dead-letters and is retried next quarter, would then act as
   * somebody whose role, org membership or employment has changed since. `02-primitives.md`
   * already frames a job as server-authoritative work. A job that must act FOR a user takes that
   * user's id in its input and re-authorises it in the body, where the check is visible in review.
   */
  readonly id?: string | undefined;
}

/**
 * Methods (not function-typed properties) throughout, so `JobHandle<Specific>` is assignable
 * to `AnyJobHandle` and heterogeneous handles can share a registry and a task's enqueue list.
 */
export interface JobHandle<I = unknown> {
  readonly kind: 'job';
  readonly name: string;
  readonly queue: string;
  readonly retry: RetryPolicy;
  /** The declared cap, resolved: the plain number, or a keyed declaration's `limit`. */
  readonly concurrency: number | undefined;
  /**
   * What a claim over the cap does — set exactly when the cap is KEYED, `undefined` for a plain
   * number and for no cap. A resolved field and never the declaration itself: `key` is a function
   * of `I`, and a function-typed property would break `AnyJobHandle` — see `tenantFor`.
   */
  readonly whenBusy: WhenBusy | undefined;
  readonly timeoutMs: number | undefined;
  /** The declared per-step ceiling in ms; `executeJob` hands it to the step runner. */
  readonly stepTimeoutMs: number | undefined;
  /** The declared event-poll interval in ms; `undefined` leaves the runner's 30s default. */
  readonly eventPollMs: number | undefined;
  readonly input: StandardSchemaV1<unknown, I>;
  parse(raw: unknown): I;
  idempotencyKeyFor(input: I): string;
  /**
   * The org THIS payload's run acts under — `undefined` for `tenant: 'none'`. A method and never a
   * `readonly tenant: JobTenant<I>` field: a function-typed property is contravariant in its
   * parameter, so `JobHandle<OrgInput>` would stop being assignable to `AnyJobHandle` and the
   * registry, the worker and a task's enqueue list could no longer hold heterogeneous handles.
   */
  tenantFor(input: I): string | undefined;
  /**
   * The concurrency key THIS payload's run counts under — `undefined` when the cap is not keyed.
   * Refuses an empty key (`X_JOB_DECLARATION_INVALID`): the facade asks it at enqueue so the
   * refusal reaches the caller, and the worker asks it again at claim.
   */
  concurrencyKeyFor(input: I): string | undefined;
  run(args: JobRunArgs<I>): Promise<unknown>;
  /** Whether the definition declared `onSettled` — published by `describe()`. */
  readonly declaresOnSettled: boolean;
  /**
   * The declared hook; a no-op when there is none. A method, for `tenantFor`'s variance reason,
   * and `unknown`-typed on both sides for the same one: the handle carries no result generic, so
   * the definition's own `onSettled` is where `result` and `input` are typed.
   */
  onSettled(settled: JobSettled<unknown>): Promise<void>;
  /**
   * Put this job on the queue. Joins the caller's transaction when the app installed the
   * outbox — same call site in a request handler, a job, a script or a test.
   */
  enqueue(input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
  /**
   * Enqueue on behalf of `actor`: fills `tenantId` from the actor's org so per-tenant limits
   * apply. It queues rather than running inline because a job's execution surface IS the
   * queue — an inline run would be a second execution path alongside `executeJob`.
   */
  as(actor: JobActor | null, input: I, options?: EnqueueOptions): Promise<EnqueueResult>;
  describe(): JobDescriptor;
}

export type AnyJobHandle = JobHandle<unknown>;

const registry = new Map<string, AnyJobHandle>();
/** Process-monotonic — `resetJobs()` deliberately leaves it alone. */
let anonymous = 0;

/**
 * Proof `job()` built this handle, plus whether its definition named itself and which export
 * name registration stamped on it. Private, and deliberately not a registry lookup: the registry
 * is what `registerJob` rewrites, so a guard that read it would reject exactly the handles
 * registration exists to rename.
 */
interface JobOrigin {
  readonly declaredName: boolean;
  /** The export name already stamped, once one has been. `undefined` while still provisional. */
  readonly exportName?: string;
}

const origin = new WeakMap<object, JobOrigin>();

/** The required fields a definition lacks, in declaration order. Read off the value, not the type. */
function missingJobFields(definition: object): string[] {
  const loose = definition as unknown as Readonly<Record<string, unknown>>;
  const missing: string[] = [];
  if (typeof loose['input'] !== 'object' || loose['input'] === null) missing.push('input');
  if (typeof loose['idempotencyKey'] !== 'function') missing.push('idempotencyKey');
  if (loose['tenant'] === undefined) missing.push('tenant');
  if (typeof loose['retry'] !== 'object' || loose['retry'] === null) missing.push('retry');
  if (typeof loose['run'] !== 'function') missing.push('run');
  return missing;
}

export function job<I, R = unknown>(definition: JobDefinition<I, R>): JobHandle<I> {
  anonymous += 1;
  const name = definition.name ?? `anonymous-job-${anonymous}`;

  // Runtime backstops for generated code and JS callers; TS already forbids omitting any of them.
  // Collected, never one at a time — see `JobDeclarationInvalidError`. The two fields with a code
  // of their own keep it when they are the only thing missing: shipped codes keep their meaning.
  const missing = missingJobFields(definition);
  if (missing.length === 1 && missing[0] === 'idempotencyKey') {
    throw new IdempotencyRequiredError({ job: name, positional: definition.name === undefined });
  }
  if (missing.length > 0 && !(missing.length === 1 && missing[0] === 'tenant')) {
    throw new JobDeclarationInvalidError({ job: name, missing });
  }
  assertJobTenant(name, definition.tenant);
  // A COUNT, so whole and finite as well as at least 1: `>= 1` alone admitted `Infinity` and
  // `1.5`, which the memory driver ran and Postgres refused at the first enqueue (`$7::int`).
  // Zero is not "never retries" — that is `attempts: 1` — it is a job that never executes at all.
  finiteCount(`job "${name}"`, 'retry.attempts', definition.retry.attempts, 1);
  // `concurrency: 0` is not "no cap" — it is a fleet slot table that grants nothing, and the job
  // is permanently unrunnable with no log line. Refused where it is written, plain or keyed.
  const concurrency = resolveConcurrency(name, definition.concurrency);

  const stepTimeoutMs =
    definition.stepTimeout === undefined
      ? undefined
      : finiteDurationMs(definition.stepTimeout, `job "${name}"`, 'stepTimeout');
  const eventPollMs =
    definition.eventPoll === undefined
      ? undefined
      : finiteDurationMs(definition.eventPoll, `job "${name}"`, 'eventPoll');
  // `withStepTimeout` reads `<= 0` as "no ceiling at all" and a poll of zero is a suspension that
  // resumes immediately, forever. Both are an author who asked for a limit and got the opposite,
  // so they are refused where they are written — the same answer `concurrency: 0` gets.
  //
  // FINITE, not merely positive: `> 0` admits `Infinity`, which is the same defect spelled the
  // other way. `eventPoll: Infinity` parks a waiting step and schedules the poll that would wake
  // it for never; `stepTimeout: Infinity` is a ceiling no step can reach. `NaN` fails `> 0` on its
  // own, and is covered here so the predicate says what it means rather than passing by accident.
  assert(
    stepTimeoutMs === undefined || (Number.isFinite(stepTimeoutMs) && stepTimeoutMs > 0),
    `job "${name}" declares stepTimeout ${String(definition.stepTimeout)}, which is no ceiling at all`,
    `set a finite positive stepTimeout on job("${name}") — "30s" or 30_000 — or omit the field for no per-step ceiling`,
  );
  assert(
    eventPollMs === undefined || (Number.isFinite(eventPollMs) && eventPollMs > 0),
    `job "${name}" declares eventPoll ${String(definition.eventPoll)}, which parks a waiting step for no time at all`,
    `set a finite positive eventPoll on job("${name}") — "5s" or 5_000 — or omit the field for the 30s default`,
  );

  const handle: JobHandle<I> = {
    kind: 'job',
    name,
    queue: definition.queue ?? DEFAULT_QUEUE,
    retry: { ...DEFAULT_RETRY, ...definition.retry },
    concurrency: concurrency.limit,
    whenBusy: concurrency.whenBusy,
    timeoutMs:
      definition.timeout === undefined
        ? undefined
        : finiteDurationMs(definition.timeout, `job "${name}"`, 'timeout'),
    stepTimeoutMs,
    eventPollMs,
    input: definition.input,
    parse(raw: unknown): I {
      return parse(definition.input, raw) as I;
    },
    idempotencyKeyFor(input: I): string {
      const key = definition.idempotencyKey(input);
      assert(
        typeof key === 'string' && key.length > 0,
        `job "${name}" idempotencyKey returned an empty string`,
        `return a non-empty stable key from job("${name}").idempotencyKey — an empty key makes every enqueue look like a duplicate of every other`,
      );
      return key;
    },
    tenantFor(input: I): string | undefined {
      return jobTenantFor(name, definition.tenant, input);
    },
    // `handle.name`, never the captured `name`: `registerJob` rebinds it in place.
    concurrencyKeyFor(input: I): string | undefined {
      return concurrency.keyFor(handle.name, input);
    },
    run(args: JobRunArgs<I>): Promise<unknown> {
      return definition.run(args);
    },
    declaresOnSettled: typeof definition.onSettled === 'function',
    onSettled(settled: JobSettled<unknown>): Promise<void> {
      // The runner hands back this job's own parsed input and this body's own return value, so
      // the cast restores exactly the types the declaration wrote.
      return definition.onSettled?.(settled as JobSettled<I, R>) ?? Promise.resolve();
    },
    enqueue(input: I, options?: EnqueueOptions): Promise<EnqueueResult> {
      return jobsFacade().enqueue(handle, input, options);
    },
    as(actor: JobActor | null, input: I, options: EnqueueOptions = {}): Promise<EnqueueResult> {
      const tenantId = options.tenantId ?? tenantFor(actor);
      // `NO_TENANT` is the limiter's own bucket for an absent tenant, so leaving the column
      // empty is the same limit and one less fake org id on the row.
      //
      // `enqueuedBy` is the actor's id and NOTHING ELSE crosses: the body runs with system
      // authority, so this is an audit column, not a principal. See `JobActor.id` for why the
      // framework chose attribution over impersonation.
      const enqueuedBy = options.enqueuedBy ?? actor?.id;
      return handle.enqueue(input, {
        ...options,
        ...(tenantId === NO_TENANT ? {} : { tenantId }),
        ...(enqueuedBy === undefined ? {} : { enqueuedBy }),
      });
    },
    // Reads `handle`, never the captured `name`: `nameJobs()` rebinds the property in place.
    describe(): JobDescriptor {
      return describeJob(handle);
    },
  };

  origin.set(handle, { declaredName: definition.name !== undefined });
  // Refused here, not at `registerJob`: a second `job({ name: 'send-digest' })` would otherwise
  // overwrite the seated handle and silently take over delivery of every row already queued
  // under that key. The anonymous names cannot collide — the counter above only ever grows.
  if (registry.has(name)) throw new JobNameTakenError({ kind: 'job', name });
  registry.set(name, handle as AnyJobHandle);
  return handle;
}

/** `orgId` is optional-with-undefined on an actor and optional-only on `tenantKeyFrom`. */
function tenantFor(actor: JobActor | null): string {
  const orgId = actor?.orgId;
  return tenantKeyFrom(orgId === undefined ? undefined : { orgId });
}

/**
 * Structural, not nominal: an object counts as a job handle only if `job()` built it, because
 * only then does a retry policy, an idempotency key and a queue exist behind it. A look-alike
 * carrying `kind: 'job'` never reaches the registry, the queue or the manifest.
 */
export function isJobHandle(value: unknown): value is AnyJobHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'job' &&
    origin.has(value)
  );
}

/**
 * Register `target` under `name`, stamping the name onto the handle the module exported rather
 * than seating a differently-named copy: `import { notifySubscribers }` is the handle
 * `enqueue()` routes through after boot, with nothing to remember.
 *
 * A definition that supplied its own `name` keeps it. A job name is the durable queue key that
 * queued, retrying and dead-lettered rows already carry, so renaming an export must never move
 * where they are delivered.
 */
export function registerJob<H extends AnyJobHandle>(name: string, target: H): H {
  const source = origin.get(target);
  const key = source?.declaredName === true ? target.name : name;
  const seated = registry.get(key);
  // Re-registering the SAME handle under the SAME name is one registration seen twice, not a
  // collision: `defineApi` hands over a feature module at boot and the framework's module scan
  // reaches the same declaration file directly. Only a DIFFERENT job under a taken name is the
  // ambiguity `X_JOB_DUPLICATE` exists to refuse.
  if (seated !== undefined) {
    if (seated !== (target as AnyJobHandle))
      throw new JobNameTakenError({ kind: 'job', name: key });
    return target;
  }
  // One handle, two export names — `export { notify as first, notify as second }`. The rebind
  // below is in place, so the second alias would move the durable queue key to whichever name
  // the module happened to export last, and queued rows would stop being delivered.
  if (source?.exportName !== undefined && source.exportName !== key)
    throw new JobNameTakenError({ kind: 'job', name: key });
  registry.delete(target.name);
  // The caller holds a reference to this exact object, so rebind its name in place.
  Object.defineProperty(target, 'name', { value: key, configurable: true });
  if (source !== undefined) origin.set(target, { ...source, exportName: key });
  registry.set(key, target as AnyJobHandle);
  return target;
}

/**
 * Called by generated code with `{ onboardOrg, sendDigest }` so queue rows carry the export
 * name rather than a positional id. `registerJobs(module)` is the call app code makes; this is
 * the same rules over an explicit record — a declared `name` wins, and a second handle under a
 * taken name is `X_JOB_DUPLICATE`.
 */
export function nameJobs(record: Readonly<Record<string, AnyJobHandle>>): void {
  for (const [exportName, handle] of Object.entries(record)) registerJob(exportName, handle);
}

export function getJob(name: string): AnyJobHandle | undefined {
  return registry.get(name);
}

/**
 * Code-unit compare, never `localeCompare`. This list is projected into `x.manifest.json`, which
 * both tracked apps COMMIT and `x verify`'s drift step diffs byte for byte — and `localeCompare`
 * with no locale argument answers from the runtime's ICU default and collation version, so the
 * same source could sort two ways on two machines. `@ultimat3/http`'s `describeRoutes` states the
 * same rule; the comparator is restated rather than imported because `http` is not below this
 * package on the tier table.
 */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function registeredJobs(): readonly AnyJobHandle[] {
  return [...registry.values()].sort((a, b) => byName(a.name, b.name));
}

/**
 * Clears the registry and NOT the counter, for `resetTasks`'s reason: an `anonymous-job-<n>`
 * re-minted after a reset shares its name with a handle an earlier test file still holds.
 */
export function resetJobs(): void {
  registry.clear();
}

/**
 * Registered jobs as the manifest, the `/_x` jobs panel and the MCP dev server need them.
 * Name-sorted because `x.manifest.json` is committed and diffed — an iteration-order-dependent
 * list would show up as a spurious change on every build. Each row is the handle's own
 * `describe()`, so the list and the single job can never disagree.
 */
export function describeJobs(): readonly JobDescriptor[] {
  return registeredJobs().map((handle) => handle.describe());
}
