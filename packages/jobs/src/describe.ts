// The JSON projection of one job handle, shared by `handle.describe()` and `describeJobs()`.
// Byte-stability is the whole point: `x.manifest.json` is committed and diffed, so anything
// clock- or iteration-order-dependent in this shape is a spurious change on every build.

import { toJsonSchema } from '@ultimat3/schema';
import type { BackoffStrategy, RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';

/** A registered job as the manifest, the `/_x` jobs panel and the MCP dev server read it. */
export interface JobDescriptor {
  readonly name: string;
  /** JSON Schema, exactly as an action's descriptor publishes one — never the schema object. */
  readonly input: Record<string, unknown>;
  readonly queue: string;
  readonly retry: { readonly attempts: number; readonly backoff: BackoffStrategy };
  readonly steps: readonly string[];
  /**
   * Whether a replayed attempt is safe to run — `job()` REQUIRES an `idempotencyKey` and refuses
   * a definition without one (`X_IDEMPOTENCY_REQUIRED`), so this is `true` for every registered
   * job. That is the point: the guarantee, published where an operator asks the question, rather
   * than left as prose in a doc. The KEY itself never crosses — it is computed from an input and
   * is app data, so a descriptor carrying it would put customer ids in `x.manifest.json`.
   */
  readonly idempotent: boolean;
}

/**
 * Narrower than `JobHandle` on purpose: the projection reads five declared fields, so keeping
 * it structural means it never has to carry — or vary with — the handle's input generic.
 */
export interface DescribableJob {
  readonly name: string;
  readonly queue: string;
  readonly retry: RetryPolicy;
  readonly input: unknown;
  /**
   * `JobHandle.idempotencyKeyFor`, read only for its presence — `unknown` because the real
   * signature is `(input: I) => string` and this shape is deliberately free of the generic.
   * Required, not optional: a descriptor built without it would publish `idempotent: false`,
   * which is the exact wrong answer the `/_x` jobs panel used to give for every job.
   */
  readonly idempotencyKeyFor: unknown;
}

export function describeJob(handle: DescribableJob): JobDescriptor {
  return {
    name: handle.name,
    input: describeSchema(handle.input),
    queue: handle.queue,
    retry: {
      attempts: handle.retry.attempts,
      backoff: handle.retry.backoff ?? DEFAULT_RETRY.backoff,
    },
    // Empty by design: step names are chosen inside `run()` at execution time, so they are
    // not statically knowable. `inspect(name)` reports the steps an actual run recorded.
    steps: [],
    idempotent: typeof handle.idempotencyKeyFor === 'function',
  };
}

/**
 * The job's input as JSON Schema. Naming the vendor — which is all this used to publish — told a
 * reader of `x.manifest.json` who validated the payload and nothing about its shape, so the one
 * fact the manifest exists to carry was missing. Never throws: a schema the active provider cannot
 * introspect degrades to a permissive object node, because a missing manifest detail must not
 * break a build.
 */
function describeSchema(schema: unknown): Record<string, unknown> {
  try {
    const converted: unknown = toJsonSchema(schema);
    if (typeof converted === 'object' && converted !== null && !Array.isArray(converted))
      return converted as Record<string, unknown>;
  } catch {
    // fall through to the permissive node
  }
  return { type: 'object', additionalProperties: true };
}
