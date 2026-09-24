// `x mcp`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-mcp.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const DEFAULT_PORT = 9229;

export const mcpSpec: CommandSpec = {
  name: 'mcp',
  summary: 'serve the dev tools: routes, schema, policies, db, queues, logs, tests, verify',
  usage: 'x mcp tools | x mcp serve [--transport stdio|http] [--port 9229] [--json]',
  requiresApp: true,
  subcommands: ['serve', 'tools'],
  // No default, deliberately: `wiki/CLI-Reference.md` already says to write `x mcp serve` rather
  // than a bare `x mcp`, and the parser's old first-element guess made the bare form START A
  // SERVER — the one thing a word typed by mistake must not do. Refusing enforces the guidance.
  flags: [
    { name: 'transport', type: 'string', summary: 'stdio | http', default: 'stdio' },
    { name: 'port', type: 'string', summary: 'HTTP port', default: String(DEFAULT_PORT) },
  ],
};
