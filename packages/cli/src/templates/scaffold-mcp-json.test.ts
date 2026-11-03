// `.mcp.json` is the one client config `x new` writes, and its command is the whole of it. A client
// may spawn that command outside the installed app, where `bunx x` fetches an unrelated npm package
// named `x` — so the spelling is pinned to the scoped package, and a regression to the short form
// fails here rather than on a stranger's machine.

import { describe, expect, test } from 'bun:test';
import { parse, t } from '@ultimat3/schema';
import { names } from './naming';
import { MCP_JSON_PATH, MCP_SERVE_COMMAND, mcpJsonFile } from './scaffold-mcp-json';

const app = names('ledger-demo');

/** The shape every client that reads `.mcp.json` reads: one server, a command and its args. */
const McpJson = t.object({
  mcpServers: t.record(t.object({ command: t.string, args: t.array(t.string) })),
});

const servers = () => {
  const file = mcpJsonFile(app);
  if (typeof file.contents !== 'string') return expect.unreachable('.mcp.json is bytes');
  return parse(McpJson, JSON.parse(file.contents), MCP_JSON_PATH).mcpServers;
};

describe('unit · .mcp.json starts the dev tools through the scoped package', () => {
  test('it lands at the repo root, one server named after the app', () => {
    expect(mcpJsonFile(app).path).toBe('.mcp.json');
    expect(Object.keys(servers())).toEqual(['ledger-demo']);
  });

  test('the command is bunx @ultimat3/cli mcp serve over stdio, never bunx x', () => {
    const server = servers()['ledger-demo'];
    const line = [server?.command, ...(server?.args ?? [])].join(' ');
    expect(line).toBe(MCP_SERVE_COMMAND);
    expect(line).toBe('bunx @ultimat3/cli mcp serve --transport stdio');
    // The short form resolves to a stranger's package wherever the app is not installed.
    expect(line).not.toContain('bunx x');
  });
});
