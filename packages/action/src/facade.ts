/**
 * The fluent surface: every projection reachable as a method on the action itself,
 * `publishPost.tool()` rather than `toMcpTool(publishPost)`, and every declared
 * field lifted off `def` so app code never reaches through `.def`. The projection
 * functions stay exported for the framework's own call sites — this file only
 * binds them to the action, it never re-implements one.
 */

import type { Actor } from '@ultimat3/core';
import {
  anonymousActor,
  createContext,
  runWithContext,
  tryUseContext,
  useContext,
  withChildContext,
} from '@ultimat3/core';
import type { InferOutput, StandardSchemaV1 } from '@ultimat3/schema';
import type { Action, ActionDef, ActionFacade, AnyAction, InvokeOptions } from './action';
import { actionName, runAction } from './action';
import { clientMethodFor } from './client';
import { contractTestsFor } from './contract-test';
import { toOpenApiOperation } from './http';
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
    // Erased at the seam; the output type is this action's by construction.
    as: (actor, input, options) =>
      runAs(self(), actor, input, options) as Promise<InferOutput<TOutput>>,
    tool: () => toMcpTool(self()),
    openapi: () => toOpenApiOperation(self()),
    client: (options) => clientMethodFor(actionName(self()), options),
    job: () => toJobHandle(self()),
    contract: (options) => contractTestsFor(self(), options),
  };
}

/**
 * `.as(actor, input)` — run this action as someone. The surrounding context is kept
 * whole (services, clock, locale, trace) and only the actor changes, so `.as()` is
 * impersonation on the one execution path, never a second one.
 */
export function runAs(
  target: AnyAction,
  actor: Actor | null,
  input: unknown,
  options: InvokeOptions = {},
): Promise<unknown> {
  // Policy models "nobody" as null; core models it as the anonymous actor.
  const patch = { actor: actor ?? anonymousActor() };
  const run = (): Promise<unknown> => runAction(target, input, { ...options, ctx: useContext() });
  const base = options.ctx ?? tryUseContext();
  return base === undefined
    ? runWithContext(createContext(patch), run)
    : runWithContext(base, () => withChildContext(patch, run));
}
