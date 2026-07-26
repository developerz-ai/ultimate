/**
 * Projection 4: an action as an MCP tool. `invoke` calls `runAction` — the same
 * function the HTTP route calls — so the tool cannot drift from the endpoint and
 * cannot acquire a second authz path. One authz system, never two.
 */
import type { Ctx } from '@ultimat3/core';
import type { AnyAction } from './action';
import { actionName, runAction } from './action';
import { type JsonSchemaObject, mcpSchemaOf, sortSchema } from './json-schema';
import { toToolName } from './naming';
import { listActions } from './registry';

export interface McpToolDescriptor {
  readonly name: string;
  /** The action's `mcp.description`, or its name when the author gave none. */
  readonly description: string;
  readonly action: string;
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
  const { def } = target;
  return {
    name: toToolName(name),
    description: def.mcp?.description ?? name,
    action: name,
    inputSchema: sortSchema(mcpSchemaOf(def.input)),
    outputSchema: sortSchema(mcpSchemaOf(def.output)),
    invoke: (input, options = {}) =>
      runAction(target, input, {
        surface: 'mcp',
        ...(options.ctx === undefined ? {} : { ctx: options.ctx }),
        idempotencyKey: options.idempotencyKey ?? null,
      }),
  };
}

/** Every action is exposed unless it sets `mcp: { expose: false }`. */
export function isExposed(target: AnyAction): boolean {
  return target.def.mcp?.expose !== false;
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
