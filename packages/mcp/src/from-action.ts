// The free-tool projection: an `action` (or `query`) with `mcp.expose` becomes an MCP tool
// at zero authorization cost.
//
// The whole claim rests on one line in `handle` below: the tool calls `action.run(...)` —
// the SAME entry point the HTTP route calls. Policy evaluation lives inside `run`, so
// there is nothing here to keep in sync and no second authz system to drift. A projected
// tool therefore declares NO `scope`: adding one would be a second gate in front of the
// only gate that matters, and the two would eventually disagree.
//
// `toMcpTool` in @ultimat3/action owns the schema half of the projection (input schema →
// JSON Schema); this file owns the execution half.

import type { Actor } from '@ultimat3/core';
import type { AnyMcpTool, McpCaller, McpRole, McpToolResult, ToolArgs } from './registry.ts';
import { jsonResult } from './registry.ts';
import type { JsonSchema } from './wire.ts';
import { NO_ARGS } from './wire.ts';

/**
 * MCP exposure as declared on an action/query (`mcp: { expose: true, description }`).
 * `visibleTo` restricts which roles may enumerate the tool; it is a catalog concern, not
 * an authz one — the policy still decides.
 */
export interface McpExposure {
  readonly expose?: boolean;
  readonly description?: string;
  readonly visibleTo?: readonly McpRole[];
  /** Override the projected tool name. Defaults to the primitive's own name. */
  readonly name?: string;
}

/**
 * The surface this projection needs from a primitive. Structurally satisfied by `Action`
 * and by `query`'s runnable handle from @ultimat3/action / @ultimat3/query — restated here
 * (rather than imported as a generic) so the projection is testable with a fake and does
 * not bind to either package's type parameters.
 */
export interface ProjectablePrimitive {
  readonly name: string;
  readonly description?: string;
  readonly mcp?: McpExposure;
  /** JSON Schema of the input, as produced by `toMcpTool`. */
  readonly inputJsonSchema?: JsonSchema;
  /** True for a mutation. Drives the rate-limit bucket; queries set it false. */
  readonly mutates?: boolean;
  /** The one server-authoritative entry point. Runs policy, then the handler. */
  run(args: { input: unknown; actor: Actor }): Promise<unknown>;
}

/** True when the primitive opted into MCP. Opt-in, never opt-out: silence exposes nothing. */
export function isExposed(primitive: ProjectablePrimitive): boolean {
  return primitive.mcp?.expose === true;
}

/**
 * Project one primitive. Throws nothing: an un-exposed primitive is a caller error caught
 * by `toolsFrom`, which filters first.
 */
export function toolFromAction(primitive: ProjectablePrimitive): AnyMcpTool {
  const name = primitive.mcp?.name ?? primitive.name;
  const description =
    primitive.mcp?.description ?? primitive.description ?? `Run the "${primitive.name}" action.`;
  const mutates = primitive.mutates ?? true;
  const visibleTo = primitive.mcp?.visibleTo;

  return {
    name,
    description,
    inputSchema: primitive.inputJsonSchema ?? NO_ARGS,
    destructive: mutates,
    ...(visibleTo !== undefined ? { visibleTo } : {}),
    // No `scope`: see the header. The action's policy is the only gate.
    async handle(args: ToolArgs, caller: McpCaller): Promise<McpToolResult> {
      // ONE authz system, TWO surfaces. HTTP does exactly this call with an actor of
      // kind 'user'; MCP does it with kind 'agent'. Same policy, same decision.
      const output = await primitive.run({ input: args, actor: caller.actor });
      return jsonResult(output);
    },
  };
}

/** Alias that reads correctly at a query call site — same projection, same guarantees. */
export const toolFromQuery = toolFromAction;

/** Project every exposed primitive, skipping the rest. Stable name order. */
export function toolsFrom(primitives: readonly ProjectablePrimitive[]): readonly AnyMcpTool[] {
  return primitives
    .filter(isExposed)
    .map(toolFromAction)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
