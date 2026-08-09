// The JSON projection of one job handle, shared by `handle.describe()` and `describeJobs()`.
// Byte-stability is the whole point: `x.manifest.json` is committed and diffed, so anything
// clock- or iteration-order-dependent in this shape is a spurious change on every build.

import type { BackoffStrategy, RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';

/** A registered job as the manifest, the `/_x` jobs panel and the MCP dev server read it. */
export interface JobDescriptor {
  readonly name: string;
  readonly input: unknown;
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

/** Best-effort JSON view of a Standard Schema; the vendor decides how much it exposes. */
function describeSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') return null;
  const vendor = (schema as { readonly '~standard'?: { readonly vendor?: string } })['~standard'];
  return { vendor: vendor?.vendor ?? 'unknown' };
}
