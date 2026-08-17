// The `job` primitive: durable background work. The shape is the contract's shape exactly.
//
// `idempotencyKey` is NON-OPTIONAL in the type. Queues deliver at least once — network
// partitions, visibility-timeout expiry and outbox relays all replay — so "did this already
// run?" is a question every job must answer. Making it optional means the answer is usually
// "nobody thought about it", and the bug (two charges, two welcome emails, two provisioned
// orgs) surfaces in production under load, never in a test. Requiring it by construction
// deletes that class of bug: there is no way to define a job that cannot be deduped.

import type { Ctx } from '@ultimat3/core';
import { assert } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { parse } from '@ultimat3/schema';
import type { DurationInput } from './clock';
import { toMs } from './clock';
import type { JobDescriptor } from './describe';
import { describeJob } from './describe';
import type { EnqueueResult } from './driver';
import { DEFAULT_QUEUE } from './driver';
import { IdempotencyRequiredError, JobNameTakenError } from './errors';
import { NO_TENANT, tenantKeyFrom } from './limits';
import type { EnqueueOptions } from './outbox';
import { jobsFacade } from './outbox';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
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
  readonly jobId: string;
  readonly runId: string;
}

export interface JobDefinition<I> {
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
   * Enforced by `JobDriver.leases` — a row every replica can see — and NOT by `limits.ts`, which
   * counts one process's heap. A driver with no lease store cannot hold this cap, so
   * `createWorker().start()` refuses to boot rather than let it pass silently
   * (`X_JOB_CONCURRENCY_UNENFORCEABLE`): this field was declared, documented and in the manifest
   * while nothing read it, which is exactly what axiom 3 exists to prevent.
   */
  readonly concurrency?: number;
  readonly timeout?: DurationInput;
  run(args: JobRunArgs<I>): Promise<unknown>;
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
  readonly concurrency: number | undefined;
  readonly timeoutMs: number | undefined;
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
  run(args: JobRunArgs<I>): Promise<unknown>;
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

export function job<I>(definition: JobDefinition<I>): JobHandle<I> {
  anonymous += 1;
  const name = definition.name ?? `anonymous-job-${anonymous}`;

  // Runtime backstops for generated code and JS callers; TS already forbids omitting either.
  if (typeof definition.idempotencyKey !== 'function') {
    throw new IdempotencyRequiredError({ job: name });
  }
  assertJobTenant(name, definition.tenant);
  assert(
    definition.retry.attempts >= 1,
    `job "${name}" needs retry.attempts >= 1, got ${String(definition.retry.attempts)}`,
    `set retry: { attempts: 1 } or higher on job("${name}") — 0 attempts means the job is never executed at all, not that it never retries`,
  );
  // `concurrency: 0` is not "no cap" — it is a fleet slot table that grants nothing.
  // `createFleetSlots.acquire` reads `limit === undefined` as uncapped, so a declared `0` reaches
  // `leases.acquire(key, 0, …)`, answers `false` forever with no log line, and the job is
  // permanently unrunnable. Refused where it is written, the way `createPacer` refuses `rate: 0`.
  assert(
    definition.concurrency === undefined ||
      (Number.isInteger(definition.concurrency) && definition.concurrency >= 1),
    `job "${name}" declares concurrency ${String(definition.concurrency)}, which no worker can ever fill`,
    `set a whole concurrency of 1 or more on job("${name}"), or omit the field for no cap at all`,
  );

  const handle: JobHandle<I> = {
    kind: 'job',
    name,
    queue: definition.queue ?? DEFAULT_QUEUE,
    retry: { ...DEFAULT_RETRY, ...definition.retry },
    concurrency: definition.concurrency,
    timeoutMs: definition.timeout === undefined ? undefined : toMs(definition.timeout),
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
    run(args: JobRunArgs<I>): Promise<unknown> {
      return definition.run(args);
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

export function registeredJobs(): readonly AnyJobHandle[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resetJobs(): void {
  registry.clear();
  anonymous = 0;
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
