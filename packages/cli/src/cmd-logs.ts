// `x logs tail` — the last lines of `.x/dev.log` (what `x dev` tees), or one role's: its
// `.x/logs/<role>.log`, else its lines of the dev log. The `logs.tail` MCP tool's reader
// (`mcp-host-logs.ts`): a shell and an agent asking "what did the server just say" get one answer.

import { isRole, ROLES } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { LOGS_DEFAULT_LINES, LOGS_MAX_LINES, logsSpec } from './cmd-logs-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { BadFlagError } from './errors';
import { parseIntFlag } from './flag-number';
import { type LogOpener, openLog, readLogTail } from './mcp-host-logs';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { resolveServices } from './runtime-bindings';

export type { LogOpener } from './mcp-host-logs';

/** `--role`, held to the runtime's roles BEFORE it is joined into a path. */
function readRole(ctx: CommandContext): string | undefined {
  const role = flagString(ctx.args, 'role');
  if (role === undefined || isRole(role)) return role;
  throw new BadFlagError({
    flag: 'role',
    command: 'logs tail',
    reason: `"${role}" is not a runtime role (known: ${ROLES.join(', ')})`,
    fix: 'x logs tail --role web --json',
  });
}

/** `open` is the seam a test hands a log through; the shipped command reads the disk. */
export const logsCommandOver = (open: LogOpener): CliCommand => ({
  spec: logsSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('logs', ctx.cwd).dir;
    // Both flags read before any file is touched: a typo costs nothing to report.
    const rawLines = flagString(ctx.args, 'lines');
    const lines =
      rawLines === undefined
        ? LOGS_DEFAULT_LINES
        : parseIntFlag(rawLines, {
            name: 'lines',
            command: 'logs tail',
            min: 1,
            max: LOGS_MAX_LINES,
            example: 'x logs tail --lines 50 --json',
          });
    const role = readRole(ctx);
    const { stateDir } = resolveServices(root, ctx.env);
    // The MCP tool's reader, not a copy: a role's own log, else its lines of the dev log, else
    // X_DEV_LOG_ABSENT naming `x dev`.
    const { path, lines: tail } = await readLogTail(stateDir, lines, role, open);
    return ok('logs', msg('cli.logs.tail', { count: tail.length, path }), {
      lines: tail,
      data: { path, role: role ?? null, lines: [...tail] },
    });
  },
});

export const logsCommand: CliCommand = logsCommandOver(openLog);
