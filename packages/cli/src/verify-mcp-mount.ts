// The `manifest` step's MCP rider: `ai.mcp.expose: true` with nothing mounted is a finding. The
// boot's own `appMcpMount` decides it — the same answer `x dev` and the web role log — so the gate
// and the boot can never disagree about whether `POST /mcp` exists. A boot only WARNED, and every
// tracked app shipped its catalog unmounted behind that warning.

import { isUltimateError } from '@ultimat3/core';
import { loadApp } from './app-load';
import { appMcpMount } from './app-mcp';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';
import { findingFrom } from './output';

/**
 * Empty when the app did not load (the load findings say so, once) or `expose` is off. A refusal
 * the mount THROWS — two files on one path (`X_MCP_PATH_DUPLICATE`), a catalog projected before the
 * scan (`X_MCP_INCLUDE_EARLY`) — is a finding too: the boot would stop on it.
 */
export async function mcpMountFindings(
  root: string,
  load: AppLoader = loadApp,
): Promise<readonly Finding[]> {
  if ((await load(root)).findings.length > 0) return [];
  try {
    const { warning } = await appMcpMount(root);
    return warning === undefined ? [] : [findingFrom(warning)];
  } catch (error) {
    if (isUltimateError(error)) return [findingFrom(error)];
    throw error;
  }
}
