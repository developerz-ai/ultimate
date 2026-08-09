/**
 * Projection 4: an action as an MCP tool. Its `invoke` is the package's `invoke`
 * — the same core the HTTP route calls — so the tool cannot drift from the
 * endpoint and cannot acquire a second authz path. One authz system, never two.
 */
import type { Ctx } from '@ultimat3/core';
import type { AnyAction } from './action';
import { actionName, defOf, invoke } from './invoke';
import { type JsonSchemaObject, mcpSchemaOf, sortSchema } from './json-schema';
import { toToolName } from './naming';
import type { ActionPolicy } from './policy-gate';
import { listActions } from './registry';

export interface McpToolDescriptor {
  readonly name: string;
  /** The action's `mcp.description`, or its name when the author gave none. */
  readonly description: string;
  readonly action: string;
  /**
   * The action's own policy object, not a copy — `tool().policy === action.policy`
   * is what makes "an MCP call cannot reach a different authz path" checkable.
   */
  readonly policy: ActionPolicy;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject;
  invoke(input: unknown, options?: McpInvokeOptions): Promise<unknown>;
}

export interface McpInvokeOptions {
  readonly ctx?: Ctx;
  readonly idempotencyKey?: string | null;
}

export function toMcpTool(target: AnyAction): McpToolDescriptor {
  const name = actionName(target);
  const def = defOf(target);
  return {
    name: toToolName(name),
    description: def.mcp?.description ?? name,
    action: name,
    policy: def.policy,
    inputSchema: sortSchema(mcpSchemaOf(def.input)),
    outputSchema: sortSchema(mcpSchemaOf(def.output)),
    invoke: (input, options = {}) =>
      invoke(target, input, {
        surface: 'mcp',
        ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
        idempotencyKey: options.idempotencyKey ?? null,
      }),
  };
}

/** Every action is exposed unless it sets `mcp: { expose: false }`. */
export function isExposed(target: AnyAction): boolean {
  return target.mcp?.expose !== false;
}

/** Deterministic order — the tool list is part of the agent-visible contract. */
export function toMcpTools(
  actions: readonly AnyAction[] = listActions(),
): readonly McpToolDescriptor[] {
  return actions
    .filter(isExposed)
    .map(toMcpTool)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
