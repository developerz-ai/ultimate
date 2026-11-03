// The `manifest` step's tool-gate half: a name in `mcpConfirmations({ tools })` that no tool answers
// to. It holds nothing, so an agent's `refundOrder` runs past a gate spelled `refundOrdr`.
// `defineAppMcp({ confirmations })` refuses that at boot for its own server; this is every other layout.

import { gatedToolNames, knownToolNames, listActions } from '@ultimat3/action';
import { ERROR_DOCS_URL, isMcpExposed } from '@ultimat3/core';
import { listQueries } from '@ultimat3/query';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';

/** Every name a gate could hold: what an agent can be offered, on either surface. */
function toolNames(): readonly string[] {
  const exposed = [...listActions(), ...listQueries()].filter((one) => isMcpExposed(one.mcp));
  return [...new Set([...exposed.map((one) => one.name), ...knownToolNames()])].sort();
}

/** Says nothing when the load failed: a short registry is the load's finding. */
export async function unknownToolGateFindings(
  root: string,
  load: AppLoader = loadApp,
): Promise<readonly Finding[]> {
  if ((await load(root)).findings.length > 0) return [];
  const known = toolNames();
  const shown = known.length === 0 ? '(none)' : known.join(', ');
  return gatedToolNames()
    .filter((name) => !known.includes(name))
    .map((name) => ({
      code: 'X_MCP_CONFIRMATION_TOOL_UNKNOWN',
      cause: `mcpConfirmations({ tools }) names ${name}, which no exposed action, exposed query, MCP tool or in-process tool answers to, so the gate holds nothing and the tool it meant runs unconfirmed`,
      fix: `mcpConfirmations({ tools: [...] })   # name tools this app declares: ${shown}`,
      docs: ERROR_DOCS_URL,
    }));
}
