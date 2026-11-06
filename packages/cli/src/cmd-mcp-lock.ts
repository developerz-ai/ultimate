// `x mcp lock <name>` — fetch a remote MCP server's tools named by the app's `mcpTools({ name,
// allow })` and write what a reviewer accepts into `tools.lock.json`. `--check` writes nothing and
// fails on a drift (`X_MCP_REMOTE_TOOL_CHANGED`): the convention's build error, for `verify`.

// why: Bun exposes no path-join primitive; the lock sits at the app root.
import { join } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import {
  assertLocked,
  declaredMcpServers,
  McpRemoteToolChangedError,
  readToolsLock,
  TOOLS_LOCK_FILE,
  writeToolsLock,
} from '@ultimat3/mcp';
import { loadApp } from './app-load';
import type { CommandContext } from './command';
import { MissingPositionalError } from './errors';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagBool } from './parse';

export async function mcpLock(ctx: CommandContext, root: string): Promise<CommandResult> {
  const name = ctx.args.positionals[0];
  if (name === undefined) {
    throw new MissingPositionalError({
      command: 'mcp lock',
      positional: 'name',
      example: 'x mcp lock <name> --json   # the name given to mcpTools({ name })',
    });
  }
  // The app's own modules evaluate every `mcpTools()`; a missing lock is a load finding, not a stop.
  await loadApp(root);
  const server = declaredMcpServers().get(name);
  if (server === undefined) {
    throw new McpRemoteToolChangedError({
      server: name,
      changes: [
        `no mcpTools({ name: ${renderFixShellArg(name, '<name>')} }) is declared (declared: ${[...declaredMcpServers().keys()].join(', ') || 'none'})`,
      ],
    });
  }
  const file = join(root, TOOLS_LOCK_FILE);
  const handle = Bun.file(file);
  const previous: unknown = (await handle.exists())
    ? ((await handle.json()) as unknown)
    : undefined;
  const live = await server.client.listTools();
  if (flagBool(ctx.args, 'check')) {
    assertLocked(name, readToolsLock(previous).get(name), server.url, server.allow, live);
    return {
      ok: true,
      command: 'mcp',
      summary: msg('cli.mcp.lock_current', { server: name, file: TOOLS_LOCK_FILE }),
      data: { server: name, file: TOOLS_LOCK_FILE, changed: false },
    };
  }
  await Bun.write(file, writeToolsLock(previous, name, server.url, server.allow, live));
  return {
    ok: true,
    command: 'mcp',
    summary: msg('cli.mcp.locked', {
      server: name,
      tools: server.allow.length,
      file: TOOLS_LOCK_FILE,
    }),
    data: { server: name, file: TOOLS_LOCK_FILE, tools: [...server.allow] },
  };
}
