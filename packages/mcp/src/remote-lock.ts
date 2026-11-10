// `tools.lock.json`: what a person reviewed of each remote MCP server — per allowed tool, the
// description the model will read and the input schema it will fill, plus `readOnly`, which only a
// person sets. `x mcp lock <name>` writes it; `mcpTools()` reads it; any difference from the live
// server is `X_MCP_REMOTE_TOOL_CHANGED`. Deterministic bytes, so a diff is the review.

import { stableStringify } from '@ultimat3/action';
import { canonicalJson, isJsonObject } from '@ultimat3/core';
import type { RemoteTool } from './remote-client';
import { McpRemoteToolChangedError } from './remote-errors';

export const TOOLS_LOCK_FILE = 'tools.lock.json';

export interface LockedTool {
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Set by a reviewer, never by the remote's hint: `false` keeps the confirmation gate binding. */
  readonly readOnly: boolean;
}

export interface LockedServer {
  readonly url: string;
  readonly tools: ReadonlyMap<string, LockedTool>;
}

/** The parsed lock: server name → its locked tools. Unknown or malformed entries are absent. */
export function readToolsLock(raw: unknown): ReadonlyMap<string, LockedServer> {
  const servers = new Map<string, LockedServer>();
  const listed = isJsonObject(raw) && isJsonObject(raw['servers']) ? raw['servers'] : {};
  for (const [name, entry] of Object.entries(listed)) {
    if (!isJsonObject(entry) || typeof entry['url'] !== 'string') continue;
    const tools = new Map<string, LockedTool>();
    for (const [tool, value] of Object.entries(
      isJsonObject(entry['tools']) ? entry['tools'] : {},
    )) {
      if (!isJsonObject(value) || !isJsonObject(value['inputSchema'])) continue;
      tools.set(tool, {
        description: typeof value['description'] === 'string' ? value['description'] : '',
        inputSchema: value['inputSchema'],
        readOnly: value['readOnly'] === true,
      });
    }
    servers.set(name, { url: entry['url'], tools });
  }
  return servers;
}

/** Why the live tools differ from the locked ones, one line per change; empty when they agree. */
export function lockChanges(
  locked: LockedServer | undefined,
  url: string,
  allow: readonly string[],
  live?: readonly RemoteTool[],
): readonly string[] {
  if (locked === undefined) return ['no entry in tools.lock.json'];
  const changes: string[] = [];
  if (locked.url !== url) changes.push(`url is ${url}, the lock has ${locked.url}`);
  const seen = live === undefined ? undefined : new Map(live.map((tool) => [tool.name, tool]));
  for (const name of allow) {
    const entry = locked.tools.get(name);
    if (entry === undefined) {
      changes.push(`"${name}" is allowed but not locked`);
      continue;
    }
    if (seen === undefined) continue;
    const current = seen.get(name);
    if (current === undefined) changes.push(`"${name}" is gone from the server`);
    else if (current.description !== entry.description)
      changes.push(`"${name}" changed its description`);
    // Core's HASH form: an equality question, never written down.
    else if (canonicalJson(current.inputSchema) !== canonicalJson(entry.inputSchema)) {
      changes.push(`"${name}" changed its input schema`);
    }
  }
  return changes;
}

export function assertLocked(
  server: string,
  locked: LockedServer | undefined,
  url: string,
  allow: readonly string[],
  live?: readonly RemoteTool[],
): void {
  const changes = lockChanges(locked, url, allow, live);
  if (changes.length > 0) throw new McpRemoteToolChangedError({ server, changes });
}

/**
 * The lock with `server` rewritten from `live`, keeping every other server and each tool's
 * reviewed `readOnly`. `@ultimat3/action`'s DOCUMENT form (`stableStringify`): sorted keys at
 * every depth and valid JSON, so the same tools are the same bytes and the file re-reads.
 */
export function writeToolsLock(
  previous: unknown,
  server: string,
  url: string,
  allow: readonly string[],
  live: readonly RemoteTool[],
): string {
  const prior = readToolsLock(previous);
  const found = new Map(live.map((tool) => [tool.name, tool]));
  const missing = allow.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new McpRemoteToolChangedError({
      server,
      changes: missing.map((name) => `"${name}" is allowed but the server does not list it`),
    });
  }
  const servers = new Map<string, unknown>();
  for (const [name, entry] of prior) servers.set(name, serialisable(entry));
  const tools = new Map<string, LockedTool>();
  for (const name of allow) {
    const tool = found.get(name);
    if (tool === undefined) continue;
    tools.set(name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: prior.get(server)?.tools.get(name)?.readOnly ?? false,
    });
  }
  servers.set(server, serialisable({ url, tools }));
  return `${stableStringify({ version: 1, servers: Object.fromEntries(servers) }, 2)}\n`;
}

function serialisable(entry: LockedServer): unknown {
  return { url: entry.url, tools: Object.fromEntries(entry.tools) };
}
