// The `manifest` step's remote-MCP half: every `mcpTools()` the app declares, its live server
// compared with `tools.lock.json` — what `x mcp lock <name> --check` does, for every name at once.
// A drift is the convention's build error (`X_MCP_REMOTE_TOOL_CHANGED`); a server that cannot be
// reached is a warning, because a third party's outage must not block an unrelated change.

// why: Bun exposes no path-join primitive; the lock sits at the app root.
import { join } from 'node:path';
import { ERROR_DOCS_URL, isUltimateError, renderThrowable } from '@ultimat3/core';
import type { DeclaredMcpServer } from '@ultimat3/mcp';
import {
  declaredMcpServers,
  lockChanges,
  McpRemoteToolChangedError,
  readToolsLock,
  TOOLS_LOCK_FILE,
} from '@ultimat3/mcp';
import { loadApp } from './app-load';
import type { AppLoader } from './app-permissions';
import type { Finding } from './output';

export interface McpLockReport {
  readonly findings: readonly Finding[];
  /** One line per server whose live list could not be read. */
  readonly warnings: readonly string[];
}

/** Says nothing when the load failed: a missing lock is already the load's finding. */
export async function mcpLockFindings(
  root: string,
  load: AppLoader = loadApp,
  servers: () => ReadonlyMap<string, DeclaredMcpServer> = declaredMcpServers,
): Promise<McpLockReport> {
  if ((await load(root)).findings.length > 0) return { findings: [], warnings: [] };
  const declared = [...servers().values()];
  if (declared.length === 0) return { findings: [], warnings: [] };
  const file = Bun.file(join(root, TOOLS_LOCK_FILE));
  const lock = readToolsLock((await file.exists()) ? ((await file.json()) as unknown) : undefined);
  const findings: Finding[] = [];
  const warnings: string[] = [];
  for (const server of declared) {
    let live: Awaited<ReturnType<DeclaredMcpServer['client']['listTools']>>;
    try {
      live = await server.client.listTools();
    } catch (error) {
      const code = isUltimateError(error) ? error.code : 'unknown';
      warnings.push(
        `${TOOLS_LOCK_FILE}: "${server.name}" was not checked, its server did not list its tools (${code}: ${renderThrowable(error)})`,
      );
      continue;
    }
    const changes = lockChanges(lock.get(server.name), server.url, server.allow, live);
    if (changes.length === 0) continue;
    const drift = new McpRemoteToolChangedError({ server: server.name, changes });
    findings.push({ code: drift.code, cause: drift.message, fix: drift.fix, docs: ERROR_DOCS_URL });
  }
  return { findings, warnings };
}
