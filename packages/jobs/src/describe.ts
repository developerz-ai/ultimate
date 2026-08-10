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
}

/**
 * Narrower than `JobHandle` on purpose: the projection reads four declared fields, so keeping
 * it structural means it never has to carry — or vary with — the handle's input generic.
 */
export interface DescribableJob {
  readonly name: string;
  readonly queue: string;
  readonly retry: RetryPolicy;
  readonly input: unknown;
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
