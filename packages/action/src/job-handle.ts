/**
 * Projection 5: an action as durable work — its input schema, a payload-derived
 * idempotency key, and an `invoke` that runs the action's one execution path under
 * `surface: 'job'`, so a queued run gets the same validation and policy evaluation
 * as the HTTP call. `@ultimat3/ai`'s `agentJob()` is the framework's one consumer — it takes any
 * `Action` and composes `job()` around this shape — and an app may write the same three lines.
 */
import type { Ctx } from '@ultimat3/core';
import { fingerprint } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action } from './action';
import { actionName, invoke } from './invoke';

/**
 * **`@ultimat3/jobs` does not consume this, and cannot as written** (`As of 2026-08`; the header
 * claimed it did). `isJobHandle` needs `kind === 'job'` AND membership of a module-private
 * `WeakMap` only `job()` writes, so no externally-built object reaches the registry, the queue or
 * the worker — and `kind: 'action-job'` is deliberately a different literal, not a near-miss.
 *
 * What it IS: the three fields plus the body a `JobDefinition` needs — `name`, `input`,
 * `idempotencyKey`, and `invoke` as its `run`. An app bridges it in one call:
 * `job({ name: h.name, input: h.input, idempotencyKey: h.idempotencyKey, tenant, retry,
 * run: ({ input, ctx }) => h.invoke(input, ctx) })`, which yields a real handle `job()` seated.
 *
 * `tenant` and `retry` are what the bridge cannot fill: both are REQUIRED on `JobDefinition` with
 * no default, on purpose — jobs states that every candidate default for `tenant` is a
 * cross-tenant read waiting to happen. So "enqueueing an action costs zero rewriting" was never
 * reachable; two facts an action does not declare have to come from somewhere. The adapter that
 * supplies them is `agentJob()` in `@ultimat3/ai` (`agent-job.ts`) — tier 4, which is where this
 * paragraph said it belongs, since `action` and `jobs` are both tier 3 and neither may import the
 * other. It takes an `Action` and nothing agent-specific, so it is the bridge for any action.
 */
export interface ActionJobHandle<
  TInput extends StandardSchemaV1 = StandardSchemaV1,
  TOutput extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly kind: 'action-job';
  /** Namespaced so an action-backed job never collides with a hand-written job. */
  readonly name: string;
  readonly input: TInput;
  /** Required by the job type: derived from the payload, stable across retries. */
  idempotencyKey(input: InferInput<TInput>): string;
  invoke(input: InferInput<TInput>, ctx: Ctx): Promise<InferOutput<TOutput>>;
}

export function toJobHandle<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  target: Action<TInput, TOutput>,
): ActionJobHandle<TInput, TOutput> {
  const name = actionName(target);
  return {
    kind: 'action-job',
    name: `action:${name}`,
    input: target.input,
    idempotencyKey: (input) => `action:${name}:${fingerprint(input)}`,
    // Schema-erased at the seam; the output type is this action's by construction.
    invoke: (input, ctx) =>
      invoke(target, input, { surface: 'job', ctx }) as Promise<InferOutput<TOutput>>,
  };
}
