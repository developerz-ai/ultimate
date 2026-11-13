// The repository's own MCP client config: `/.mcp.json` is gitignored (25.0.0 — a contributor's copy
// may carry API keys), so the tracked `.mcp.json.example` is the one source and `bun run setup`
// copies it when the file is absent. A contributor's own file is never overwritten.

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';

export const MCP_EXAMPLE = '.mcp.json.example';
export const MCP_CONFIG = '.mcp.json';

/** What `copyMcpConfig` did: wrote the file, kept the one there, or had no example to copy. */
export type McpConfigOutcome = 'wrote' | 'kept' | 'no-example';

/** `.mcp.json` from `.mcp.json.example`, only when absent — idempotent, as `setup` must be. */
export async function copyMcpConfig(root: string): Promise<McpConfigOutcome> {
  const target = Bun.file(join(root, MCP_CONFIG));
  if (await target.exists()) return 'kept';
  const example = Bun.file(join(root, MCP_EXAMPLE));
  if (!(await example.exists())) return 'no-example';
  await Bun.write(target, await example.text());
  return 'wrote';
}
