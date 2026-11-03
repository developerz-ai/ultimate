// The way a projected tool reaches its `run`: the actor half of the policy, then the tool gate
// `mcpConfirmations` registered for that name, then the tool. Split from `tools.ts`, which adapts
// and renders. MCP's order, restated because `mcp` is this package's tier, and for the same reason:
// a caller the tool refuses outright opens no row for a person to look at.

import { toolGateFor } from '@ultimat3/action';
import type { Actor } from '@ultimat3/core';
import type { ProjectableAction } from './tools';

/**
 * What already passes the gate, by its `run`: projecting one twice would ask twice and spend the
 * approval on the outer pass. Keyed on the function because `{ ...projected, description }` is a
 * new object carrying the same `run`, and a second gate on it would never let the tool run.
 */
const throughGate = new WeakSet<ProjectableAction['run']>();

export const passesToolGate = (tool: ProjectableAction): boolean => throughGate.has(tool.run);

/**
 * `tool`, with its `run` behind the gate. The gate is looked up per call, because the module declaring
 * it may evaluate after the agent listing the tool. `admit` throws for a caller the tool's policy
 * refuses before reading the input. An ungated tool skips it: `invoke` opens with the same question.
 */
export function behindToolGate(
  tool: ProjectableAction,
  admit?: (actor: Actor) => void,
): ProjectableAction {
  const run: ProjectableAction['run'] = async (args) => {
    const gate = toolGateFor(tool.name);
    if (gate === undefined) return tool.run(args);
    admit?.(args.actor);
    return gate(
      {
        tool: tool.name,
        args: args.input,
        inputSchema: tool.inputJsonSchema,
        actor: args.actor,
      },
      async () => tool.run(args),
    );
  };
  throughGate.add(run);
  // Inherits from `tool`, so what a class declares on its prototype still reads; the own fields are
  // copied as well, so a spread of this copy keeps them and is not a nameless tool.
  return Object.assign(Object.create(tool), tool, { run });
}
