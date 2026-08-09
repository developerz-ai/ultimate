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
import { IdempotencyRequiredError } from './errors';
import { NO_TENANT, tenantKeyFrom } from './limits';
import type { EnqueueOptions } from './outbox';
import { jobsFacade } from './outbox';
import type { RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';
import type { StepApi } from './steps';

export interface JobRunArgs<I> {
  readonly input: I;
  readonly step: StepApi;
  readonly ctx: Ctx;
  /** 1-based. Assume at-least-once: never branch on `attempt === 1` for correctness. */
  readonly attempt: number;
  readonly jobId: string;
  readonly runId: string;
}

export interface JobDefinition<I> {
  /** Assigned by `x manifest` from the export name; only set by hand in tests. */
  readonly name?: string;
  readonly input: StandardSchemaV1<unknown, I>;
  /** REQUIRED. See the file header — this is the whole point. */
  readonly idempotencyKey: (input: I) => string;
  readonly retry: RetryPolicy;
  readonly queue?: string;
  /** Max in-flight runs of THIS job across the fleet. Omit for the queue-wide cap. */
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

export function job<I>(definition: JobDefinition<I>): JobHandle<I> {
  anonymous += 1;
  const name = definition.name ?? `anonymous-job-${anonymous}`;

  // Runtime backstop for generated code and JS callers; TS already forbids omitting it.
  if (typeof definition.idempotencyKey !== 'function') {
    throw new IdempotencyRequiredError({ job: name });
  }
  assert(
    definition.retry.attempts >= 1,
    `job "${name}" needs retry.attempts >= 1, got ${String(definition.retry.attempts)}`,
    `set retry: { attempts: 1 } or higher on job("${name}") — 0 attempts means the job is never executed at all, not that it never retries`,
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
      return handle.enqueue(input, {
        ...options,
        ...(tenantId === NO_TENANT ? {} : { tenantId }),
      });
    },
    // Reads `handle`, never the captured `name`: `nameJobs()` rebinds the property in place.
    describe(): JobDescriptor {
      return describeJob(handle);
    },
  };

  registry.set(name, handle as AnyJobHandle);
  return handle;
}

/** `orgId` is optional-with-undefined on an actor and optional-only on `tenantKeyFrom`. */
function tenantFor(actor: JobActor | null): string {
  const orgId = actor?.orgId;
  return tenantKeyFrom(orgId === undefined ? undefined : { orgId });
}

/**
 * Called by generated code with `{ onboardOrg, sendDigest }` so queue rows carry the export
 * name rather than a positional id. Enqueue works either way; the name is for humans.
 */
export function nameJobs(record: Readonly<Record<string, AnyJobHandle>>): void {
  for (const [exportName, handle] of Object.entries(record)) {
    if (handle.name === exportName) continue;
    registry.delete(handle.name);
    // The caller holds a reference to this exact object, so rebind its name in place.
    Object.defineProperty(handle, 'name', { value: exportName, configurable: true });
    registry.set(exportName, handle);
  }
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
