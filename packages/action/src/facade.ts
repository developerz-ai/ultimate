/**
 * The fluent surface: every projection reachable as a method on the action itself,
 * `publishPost.tool()` rather than `toMcpTool(publishPost)`, and every declared
 * field lifted off `def` so app code never reaches through `.def`. The projection
 * functions stay exported for the framework's own call sites — this file only
 * binds them to the action, it never re-implements one.
 */

import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action, ActionDef, ActionFacade } from './action';
import { clientMethodFor } from './client';
import { contractTestsFor } from './contract-test';
import { toOpenApiOperation } from './http';
import { actionName, invoke } from './invoke';
import { toJobHandle } from './job-handle';
import { toMcpTool } from './mcp-tool';

/**
 * `self` is a thunk on purpose: the façade is attached while the action is still
 * being assembled, so every method resolves the action when it is called, not now.
 */
export function facadeFor<TInput extends StandardSchemaV1, TOutput extends StandardSchemaV1>(
  def: ActionDef<TInput, TOutput>,
  self: () => Action<TInput, TOutput>,
): ActionFacade<TInput, TOutput> {
  return {
    input: def.input,
    output: def.output,
    policy: def.policy,
    ...(def.mcp === undefined ? {} : { mcp: def.mcp }),
    // `.as()` is impersonation on the one execution path: `invoke` keeps the
    // surrounding context whole and swaps only the actor. Erased at the seam;
    // the output type is this action's by construction.
    as: (actor, input, options) =>
      invoke(self(), input, { ...options, actor }) as Promise<InferOutput<TOutput>>,
    tool: () => toMcpTool(self()),
    openapi: () => toOpenApiOperation(self()),
    client: (options) => clientMethodFor(actionName(self()), options),
    job: () => toJobHandle(self()),
    contract: (options) => contractTestsFor(self(), options),
  };
}
