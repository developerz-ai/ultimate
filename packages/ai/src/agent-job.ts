/**
 * `agentJob()` — an agent as durable, resumable, budgeted background work.
 *
 * The bridge `packages/action/src/job-handle.ts` names in its own header and could not build:
 * `isJobHandle` needs `kind === 'job'` PLUS membership of a WeakMap only `job()` writes, so no
 * externally-shaped object reaches the registry, the queue or the worker — and `action` and `jobs`
 * are both tier 3, so neither may import the other. This package is tier 4 and may import both,
 * which is exactly where that header says the adapter belongs.
 *
 * It composes `job()` rather than re-implementing a handle: the returned value IS one `job()`
 * seated, so `.enqueue()`, the outbox, the worker's cancellation, the dead-letter path,
 * `x jobs show` and its manifest row all arrive without a line here.
 */

import type { Action, ActionJobHandle } from '@ultimat3/action';
import type { JobHandle, JobTenant, RetryPolicy } from '@ultimat3/jobs';
import { job } from '@ultimat3/jobs';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';

export interface AgentJobOptions<I> {
  /**
   * The durable queue key. REQUIRED and never derived from the agent's export name: a job name is
   * what queued, retrying and dead-lettered rows already carry, so renaming an export must not
   * move where they are delivered.
   */
  readonly name: string;
  /**
   * REQUIRED, no default, and the org this run's body acts under. `jobs` states why: every
   * candidate default is a cross-tenant read waiting for the first job that takes an org id in its
   * input. `tenant: 'none'` is the explicit statement that this agent touches no tenant-scoped
   * table, and then every scoped read inside it fails closed.
   */
  readonly tenant: JobTenant<I>;
  /** REQUIRED, no default. A model call fails transiently; how many times is nobody else's guess. */
  readonly retry: RetryPolicy;
  readonly queue?: string;
  /**
   * Defaults to the action projection's own key — `action:<name>:<fingerprint of input>` — which
   * is stable across retries and derived from the payload alone.
   *
   * **It dedupes the ENQUEUE, never the ATTEMPT.** Two `enqueue` calls with the same payload are
   * one row; one row that a worker claims, half-runs and loses the lease on is claimed again, and
   * the agent runs a second time from the top. Combined with `backfill()`, whose `handle` is at
   * least once by construction, a replayed page re-runs every agent on it.
   *
   * What that means for `tools`: **every tool the agent may call has to be idempotent** — an
   * `upsertAll`, an `updateWhere`, a statement whose second run changes nothing — because a
   * replayed attempt issues a second `issueRefund` otherwise. The framework does NOT check this and
   * cannot: `mutates` is not a fact an `action()` declares (`@ultimat3/mcp` sets it to `true` for
   * every action it projects), so a read-only `lookupOrder` and a destructive `issueRefund` are
   * indistinguishable here, and a rule refusing both would be a wrong refusal. See the README.
   */
  idempotencyKey?(input: I): string;
}

/**
 * Wrap an `agent()` — or any action — as a real job handle.
 *
 * Both reads of the underlying projection are LAZY, and that is load-bearing: `target.job()` calls
 * `actionName()`, which throws `X_ACTION_UNREGISTERED` until `registerAction` stamps the export
 * name at boot — and `agentJob()` is evaluated at module scope, right beside the `agent()` it
 * wraps. The queue key comes from `options.name` for the same reason it is required.
 */
export function agentJob<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
  options: AgentJobOptions<InferOutput<TInput>>,
): JobHandle<InferOutput<TInput>> {
  let projected: ActionJobHandle<TInput, TOutput> | undefined;
  const bridge = (): ActionJobHandle<TInput, TOutput> => {
    if (projected === undefined) projected = target.job();
    return projected;
  };
  return job<InferOutput<TInput>>({
    name: options.name,
    input: target.input as StandardSchemaV1<unknown, InferOutput<TInput>>,
    tenant: options.tenant,
    retry: options.retry,
    ...(options.queue === undefined ? {} : { queue: options.queue }),
    idempotencyKey: (input) =>
      options.idempotencyKey?.(input) ?? bridge().idempotencyKey(asInput<TInput>(input)),
    // ONE execution path, and it is the action's. `ActionJobHandle.invoke` is `invoke(target,
    // input, { surface: 'job', ctx })`, so the agent's policy, its input parse, its budget scope
    // and its span all apply — and `ctx` is the WORKER's, so `ctx.signal` aborting at the attempt
    // timeout reaches the agent's turn loop.
    run: ({ input, ctx }) => bridge().invoke(asInput<TInput>(input), ctx),
  });
}

/**
 * The job parsed with the action's OWN schema, so what it hands back is a value that schema
 * accepts — `invoke` re-parses it regardless, which is what makes this safe rather than merely
 * convenient. The cast exists because `InferOutput` and `InferInput` are different types wherever a
 * field has a default, and nothing at this seam can prove they meet.
 */
function asInput<TInput extends StandardSchemaV1>(value: InferOutput<TInput>): InferInput<TInput> {
  return value as InferInput<TInput>;
}
