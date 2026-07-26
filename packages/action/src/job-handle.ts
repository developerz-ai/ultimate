/**
 * Projection 5: an action as durable work. `@ultimat3/jobs` consumes this shape,
 * so enqueueing an existing action costs zero rewriting — and the queued run
 * goes through the same validation and policy evaluation as the HTTP call.
 */
import type { Ctx } from '@ultimat3/core';
import type { InferInput, InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action } from './action';
import { actionName, runAction } from './action';
import { fingerprint } from './stable';

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
    input: target.def.input,
    idempotencyKey: (input) => `action:${name}:${fingerprint(input)}`,
    // Schema-erased at the seam; the output type is this action's by construction.
    invoke: (input, ctx) =>
      runAction(target, input, { surface: 'job', ctx }) as Promise<InferOutput<TOutput>>,
  };
}
