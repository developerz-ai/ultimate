// The size of what an agent READS from this server, measured off the wire, and a budget an app's
// test holds it to. `tools/list` is re-sent with every step of every turn and `list_resources` is
// read once a session and then sits in the transcript — both are standing context the model pays
// for whether or not it uses them, so a number with a test beside it is the only way they stay
// small (gold standard: context-budget.md, "guard the numbers with tests").

import { McpSurfaceOverBudgetError } from './errors';
import { LIST_RESOURCES } from './meta-surface';
import type { McpCaller } from './registry';
import type { McpServer } from './server';

/** Characters, as serialized on the wire — what a client hands its model. */
export interface McpSurfaceSize {
  /** `JSON.stringify` of the `tools/list` result this caller gets. */
  readonly toolsList: number;
  /** The text of `list_resources({})`, or `undefined` for a caller served the flat surface. */
  readonly listResources: number | undefined;
  /** `initialize`'s `instructions`; `0` when none are sent to this caller. */
  readonly instructions: number;
}

/** A ceiling per surface, in characters. An omitted surface is measured and not judged. */
export interface McpSurfaceBudget {
  readonly toolsList?: number;
  readonly listResources?: number;
  readonly instructions?: number;
}

/** Measure the three surfaces for ONE caller — a per-population server answers each differently. */
export async function measureMcpSurface(
  server: McpServer,
  caller: McpCaller,
): Promise<McpSurfaceSize> {
  const init = resultOf(
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, caller),
  );
  const instructions = init?.['instructions'];
  const list = resultOf(
    await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, caller),
  );
  const tools = Array.isArray(list?.['tools'])
    ? (list['tools'] as readonly { name?: unknown }[])
    : [];
  let listResources: number | undefined;
  if (tools.some((tool) => tool.name === LIST_RESOURCES)) {
    const called = resultOf(
      await server.handle(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: LIST_RESOURCES, arguments: {} },
        },
        caller,
      ),
    );
    listResources = textLength(called?.['content']);
  }
  return {
    toolsList: JSON.stringify(list ?? {}).length,
    listResources,
    instructions: typeof instructions === 'string' ? instructions.length : 0,
  };
}

/**
 * Measure, then refuse any surface over its budget with `X_MCP_SURFACE_OVER_BUDGET` naming every
 * one. Returns the measurement so a test can print it next to the number it chose.
 *
 * ```ts
 * test('the staff surface stays small', async () => {
 *   await assertMcpSurfaceBudget(mcp.server, staffCaller, { toolsList: 4_000, listResources: 12_000 });
 * });
 * ```
 *
 * Size a budget from the measured value times a margin, and write the derivation beside it.
 */
export async function assertMcpSurfaceBudget(
  server: McpServer,
  caller: McpCaller,
  budget: McpSurfaceBudget,
): Promise<McpSurfaceSize> {
  const size = await measureMcpSurface(server, caller);
  const over: { surface: string; size: number; budget: number }[] = [];
  const judge = (surface: string, measured: number | undefined, ceiling: number | undefined) => {
    if (measured !== undefined && ceiling !== undefined && measured > ceiling) {
      over.push({ surface, size: measured, budget: ceiling });
    }
  };
  judge('tools/list', size.toolsList, budget.toolsList);
  judge('list_resources', size.listResources, budget.listResources);
  judge('instructions', size.instructions, budget.instructions);
  if (over.length > 0) throw new McpSurfaceOverBudgetError({ over });
  return size;
}

function resultOf(
  response: { readonly result?: unknown } | null,
): Record<string, unknown> | undefined {
  const result = response?.result;
  return typeof result === 'object' && result !== null
    ? (result as Record<string, unknown>)
    : undefined;
}

function textLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content as readonly { readonly text?: unknown }[]) {
    if (typeof block.text === 'string') total += block.text.length;
  }
  return total;
}
