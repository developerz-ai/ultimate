// `x mcp serve` — the framework's own MCP server over stdio or HTTP. Read tools are unrestricted
// in dev; write tools are scoped to a branch database. Same facts as `x manifest` and `x routes`,
// so an agent never has to parse terminal output to learn what the app contains.

import { describeRoutes } from '@ultimat3/render';
import { checkAppBoundaries } from './app-boundaries';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import type { CliErrorCode } from './errors';
import { CLI_ERROR_CODES, docsFor } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagString } from './parse';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  run(root: string, input: Readonly<Record<string, unknown>>): Promise<JsonValue>;
}

const errorExplanation = (code: string): JsonValue => {
  const known: readonly string[] = CLI_ERROR_CODES;
  if (!known.includes(code)) {
    return { code, known: false, docs: `https://ultimate.dev/errors/${code}` };
  }
  return { code, known: true, docs: docsFor(code as CliErrorCode) };
};

export const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'manifest.get',
    description: 'The whole x.manifest.json: routes, actions, jobs, policies, entities',
    readOnly: true,
    run: async (root) => (await appManifest(root)).manifest as unknown as JsonValue,
  },
  {
    name: 'routes.list',
    description: 'Route table with render mode, hydrate, offline strategy and budget',
    readOnly: true,
    run: async (root) => {
      await loadApp(root);
      return describeRoutes().map((route) => ({
        path: route.path,
        file: route.file,
        surface: route.surface,
      })) as JsonValue;
    },
  },
  {
    name: 'boundaries.check',
    description: 'Surface and layer import violations, each with the fix command',
    readOnly: true,
    run: async (root) => (await checkAppBoundaries(root)) as unknown as JsonValue,
  },
  {
    name: 'errors.explain',
    description: 'X_* code to cause, fix command and docs URL',
    readOnly: true,
    run: async (_root, input) => errorExplanation(String(input['code'] ?? '')),
  },
];

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: number | string;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

const result = (id: number | string | undefined, payload: JsonValue): string =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: payload });

const rpcError = (id: number | string | undefined, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One dispatcher for both transports: stdio and HTTP must never answer differently. */
export async function handleRpc(root: string, raw: string): Promise<string> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return rpcError(undefined, -32700, 'parse error');
  }
  if (request.method === 'initialize') {
    return result(request.id, {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'ultimate', version: '0.0.1' },
      capabilities: { tools: {} },
    });
  }
  if (request.method === 'tools/list') {
    return result(
      request.id,
      MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        readOnly: tool.readOnly,
      })),
    );
  }
  if (request.method === 'tools/call') {
    const params = request.params ?? {};
    const name = String(params['name'] ?? '');
    const tool = MCP_TOOLS.find((entry) => entry.name === name);
    if (tool === undefined) {
      return rpcError(request.id, -32601, `unknown tool "${name}" — call tools/list`);
    }
    const args = (params['arguments'] ?? {}) as Readonly<Record<string, unknown>>;
    const payload = await tool.run(root, args);
    return result(request.id, payload);
  }
  return rpcError(request.id, -32601, `unknown method "${request.method}"`);
}

async function serveStdio(root: string): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of decoder.decode(chunk).split('\n')) {
      if (line.trim().length === 0) continue;
      process.stdout.write(`${await handleRpc(root, line)}\n`);
    }
  }
}

export const mcpCommand: CliCommand = {
  spec: {
    name: 'mcp',
    summary: 'serve the framework MCP tools over stdio or HTTP',
    usage: 'x mcp serve [--transport stdio|http] [--port 9229] [--json]',
    requiresApp: true,
    subcommands: ['serve', 'tools'],
    flags: [
      { name: 'transport', type: 'string', summary: 'stdio | http', default: 'stdio' },
      { name: 'port', type: 'string', summary: 'HTTP port', default: '9229' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('mcp', ctx.cwd).dir;
    const transport = flagString(ctx.args, 'transport') ?? 'stdio';
    if (ctx.args.subcommand === 'tools') {
      return {
        ok: true,
        command: 'mcp',
        summary: msg('cli.mcp.serving', { transport: 'none', tools: MCP_TOOLS.length }),
        data: MCP_TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
        lines: MCP_TOOLS.map((tool) => `  ${tool.name.padEnd(20)} ${tool.description}`),
      };
    }
    if (transport === 'http') {
      const port = Number.parseInt(flagString(ctx.args, 'port') ?? '9229', 10);
      const server = Bun.serve({
        port,
        fetch: async (request) =>
          new Response(await handleRpc(root, await request.text()), {
            headers: { 'content-type': 'application/json' },
          }),
      });
      return {
        ok: true,
        command: 'mcp',
        summary: msg('cli.mcp.serving', { transport: 'http', tools: MCP_TOOLS.length }),
        data: { url: `http://localhost:${server.port}`, tools: MCP_TOOLS.length },
      };
    }
    await serveStdio(root);
    return {
      ok: true,
      command: 'mcp',
      summary: msg('cli.mcp.serving', { transport: 'stdio', tools: MCP_TOOLS.length }),
      data: { tools: MCP_TOOLS.length },
    };
  },
};
