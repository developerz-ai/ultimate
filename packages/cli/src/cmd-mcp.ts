// `x mcp serve` — the framework's dev MCP server over stdio or HTTP. The 13 tools, the JSON-RPC
// dispatch, both transports and the structural SQL refusals all come from `@ultimat3/mcp`; the CLI
// supplies only the app, the caller and the socket. A tool answered here would be a second answer
// to a question the framework already answers.

import { markListening, nanoid, timingSafeEqual } from '@ultimat3/core';
import { mcpHttpRoute, serveStdio } from '@ultimat3/mcp';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError } from './errors';
import { holdUntilShutdown } from './hold';
import type { CliMcpServer } from './mcp-host';
import { createDevMcpServer, DEV_TOOL_SCOPES } from './mcp-host';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';

const DEFAULT_PORT = 9229;
const TRANSPORTS = ['stdio', 'http'] as const;
type Transport = (typeof TRANSPORTS)[number];

/** One reading of the entitlement, so `--json` and the terminal can never disagree about it. */
const scopes = (): readonly string[] => [...DEV_TOOL_SCOPES].sort();

const scopeLine = (): string => msg('cli.mcp.scopes', { scopes: scopes().join(' ') });

const isTransport = (value: string): value is Transport =>
  (TRANSPORTS as readonly string[]).includes(value);

/** The catalog, from the server's own registry — never a list kept here. */
async function catalog(host: CliMcpServer): Promise<CommandResult> {
  const tools = host.server.list(host.caller);
  await host.close();
  return {
    ok: true,
    command: 'mcp',
    summary: msg('cli.mcp.serving', { transport: 'none', tools: tools.length }),
    // `scopes` rides in `data` because it rides in `lines`: every fact the terminal prints is a
    // fact `--json` carries, or the two renderers have drifted.
    data: {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
      scopes: scopes(),
    },
    lines: [...tools.map((tool) => `  ${tool.name.padEnd(20)} ${tool.description}`), scopeLine()],
  };
}

const notFound = (path: string): Response =>
  new Response(
    JSON.stringify({
      code: 'X_MCP_PROTOCOL',
      cause: 'the MCP server answers exactly one route',
      fix: `POST ${path} with an Authorization: Bearer header`,
    }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );

/** A running HTTP transport. `stop()` releases the socket AND the host's lazily booted services. */
export interface McpHttpServer {
  readonly result: CommandResult;
  stop(): Promise<void>;
}

/**
 * HTTP demands a bearer token, and a token in a config file is one more thing to keep in sync — so
 * it is minted per process and returned in `data`, where `--json` puts it one read away.
 *
 * Exported with its stop handle rather than swallowing it: the socket and the host's PGlite data
 * directory outlive `run()` otherwise, and nothing — a test, an embedding caller, or a signal —
 * could ever release them.
 */
export function startMcpHttp(host: CliMcpServer, port: number): McpHttpServer {
  const token = nanoid(32);
  const route = mcpHttpRoute({
    server: host.server,
    // `timingSafeEqual`, not `===`: this was the only secret comparison in the framework that
    // short-circuited on the first differing character. Localhost and a per-process `nanoid(32)`
    // make it hard to exploit and neither makes it correct — an exception nobody can point at is
    // an exception the next transport copies.
    resolveToken: (candidate) =>
      timingSafeEqual(candidate, token)
        ? { actor: host.caller.actor, scopes: DEV_TOOL_SCOPES }
        : null,
  });
  const handle = Bun.serve({
    port,
    hostname: 'localhost',
    fetch: (request: Request): Response | Promise<Response> => {
      const url = new URL(request.url);
      if (request.method !== route.method || url.pathname !== route.path) {
        return notFound(route.path);
      }
      return route.handle(request);
    },
  });
  // Announces the socket as this process's own, so a caller on it is never mistaken for egress.
  const stopListening = markListening(handle.url.origin);
  const url = `${handle.url.origin}${route.path}`;
  return {
    result: {
      ok: true,
      command: 'mcp',
      summary: msg('cli.mcp.serving', { transport: 'http', tools: host.tools.length }),
      data: { url, token, tools: host.tools.length, scopes: scopes() },
      lines: [`  POST ${url}`, `  authorization: Bearer ${token}`, scopeLine()],
    },
    async stop() {
      await handle.stop(true);
      stopListening();
      await host.close();
    },
  };
}

/**
 * stdout is the WIRE. `dispatch.ts` renders a `CommandResult` only after `run` resolves, and this
 * resolves when the peer closes stdin — so the command's own output cannot reach stdout while a
 * session is live, and nothing here writes to it directly.
 */
async function serveOverStdio(host: CliMcpServer): Promise<CommandResult> {
  await serveStdio({ server: host.server, caller: host.caller });
  await host.close();
  return {
    ok: true,
    command: 'mcp',
    summary: msg('cli.mcp.serving', { transport: 'stdio', tools: host.tools.length }),
    data: { transport: 'stdio', tools: host.tools.length },
  };
}

function readPort(ctx: CommandContext): number {
  const raw = flagString(ctx.args, 'port') ?? String(DEFAULT_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BadFlagError({
      flag: 'port',
      command: 'mcp serve',
      reason: `expects a port in 0..65535, got "${raw}"`,
      fix: `x mcp serve --transport http --port ${DEFAULT_PORT}`,
    });
  }
  return port;
}

export const mcpCommand: CliCommand = {
  spec: {
    name: 'mcp',
    summary: 'serve the dev tools: routes, schema, policies, db, queues, logs, tests, verify',
    usage: 'x mcp tools | x mcp serve [--transport stdio|http] [--port 9229] [--json]',
    requiresApp: true,
    subcommands: ['serve', 'tools'],
    flags: [
      { name: 'transport', type: 'string', summary: 'stdio | http', default: 'stdio' },
      { name: 'port', type: 'string', summary: 'HTTP port', default: String(DEFAULT_PORT) },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('mcp', ctx.cwd).dir;
    const transport = flagString(ctx.args, 'transport') ?? 'stdio';
    // Validated before the app is loaded: a typo must not cost a boot to report.
    if (!isTransport(transport)) {
      throw new BadFlagError({
        flag: 'transport',
        command: 'mcp serve',
        reason: `expects ${TRANSPORTS.join(' or ')}, got "${transport}"`,
        fix: 'x mcp serve --transport stdio',
      });
    }
    const port = readPort(ctx);
    const host = await createDevMcpServer({ root, env: ctx.env, runner: ctx.runner });
    if (ctx.args.subcommand === 'tools') return catalog(host);
    if (transport !== 'http') return serveOverStdio(host);
    // Long-running: the process stays alive on the server handle. The stop handle goes to the
    // shutdown registry so a signal releases the socket and the database, not the exit code alone.
    // Long-running, exactly as `x dev` is: `dispatch` awaits the hold, and the drain a signal
    // starts is what releases the socket and the database. Registering a shutdown hook and
    // returning was the older shape — nothing installed a signal handler, so the hook was never
    // reached and the exit code closed the socket the line above had just announced.
    const served = startMcpHttp(host, port);
    return { ...served.result, hold: holdUntilShutdown('mcp', () => served.stop()) };
  },
};
