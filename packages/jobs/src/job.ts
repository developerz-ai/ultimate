// The `job` primitive: durable background work. The shape is the contract's shape exactly.
//
// `idempotencyKey` is NON-OPTIONAL in the type. Queues deliver at least once — network
// partitions, visibility-timeout expiry and outbox relays all replay — so "did this already
// run?" is a question every job must answer. Making it optional means the answer is usually
// "nobody thought about it", and the bug (two charges, two welcome emails, two provisioned
// orgs) surfaces in production under load, never in a test. Requiring it by construction
// deletes that class of bug: there is no way to define a job that cannot be deduped.

import { assert, finiteCount } from '@ultimat3/core';
import { parse } from '@ultimat3/schema';
import { finiteDurationMs } from './clock';
import { resolveConcurrency } from './concurrency';
import type { JobDescriptor } from './describe';
import { describeJob } from './describe';
import type { EnqueueResult } from './driver';
import { DEFAULT_QUEUE } from './driver';
import { IdempotencyRequiredError, JobNameTakenError } from './errors';
import { JobDeclarationInvalidError, missingJobFields } from './errors-declaration';
import type { EnqueueManyOptions } from './job-enqueue-many';
import { NO_TENANT, tenantKeyFrom } from './limits';
import type { EnqueueOptions } from './outbox';
import { jobsFacade } from './outbox';
import { DEFAULT_RETRY } from './retry';
import type { JobSettled } from './settled';
import { ON_SETTLED_TIMEOUT_MS } from './settled';
import { assertJobTenant, jobTenantFor } from './tenant';

export type { AnyJobHandle, JobActor, JobDefinition, JobHandle, JobRunArgs } from './job-types';

import type { AnyJobHandle, JobActor, JobDefinition, JobHandle, JobRunArgs } from './job-types';

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
  const onSettledTimeoutMs =
    definition.onSettledTimeout === undefined
      ? ON_SETTLED_TIMEOUT_MS
      : finiteDurationMs(definition.onSettledTimeout, `job "${name}"`, 'onSettledTimeout');
  assert(
    onSettledTimeoutMs > 0,
    `job "${name}" declares onSettledTimeout ${String(definition.onSettledTimeout)}, which is no ceiling at all`,
    `set a finite positive onSettledTimeout on job("${name}") — "30s" or 30_000 — or omit the field for the default`,
  );
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
    onSettledTimeoutMs,
    eventPollMs,
    compensates: definition.compensates === true,
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
    enqueueMany(inputs: readonly I[], options?: EnqueueManyOptions) {
      return jobsFacade().enqueueMany(handle, inputs, options);
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
