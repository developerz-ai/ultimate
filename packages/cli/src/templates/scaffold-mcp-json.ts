// `.mcp.json`: the one MCP client config `x new` writes, in the format several clients read. It
// starts `x mcp serve` over stdio — the dev tools — through the SCOPED package, because a client may
// spawn the command outside the installed app, and there `bunx x` fetches an unrelated npm package.
// A client that wants another file is told how in `wiki/MCP-And-AI.md`, never generated for.

import type { GeneratedFile, NameSet } from './naming';

export const MCP_JSON_PATH = '.mcp.json';

const COMMAND = 'bunx';
const ARGS = ['@ultimat3/cli', 'mcp', 'serve', '--transport', 'stdio'] as const;

/** The line the file encodes, as a shell would run it — what the docs and the smoke both quote. */
export const MCP_SERVE_COMMAND = [COMMAND, ...ARGS].join(' ');

/** The file itself, Biome-formatted: one server, keyed by the app's name. */
export function mcpJsonFile(app: NameSet): GeneratedFile {
  const args = ARGS.map((arg) => `"${arg}"`).join(', ');
  return {
    path: MCP_JSON_PATH,
    contents: `{
  "mcpServers": {
    "${app.kebab}": {
      "command": "${COMMAND}",
      "args": [${args}]
    }
  }
}
`,
  };
}
