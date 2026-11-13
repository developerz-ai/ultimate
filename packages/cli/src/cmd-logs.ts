// `x logs tail` — the last lines of `.x/dev.log` (what `x dev` tees) or of one role's
// `.x/logs/<role>.log`. The same file, path rule and end-first reader as the `logs.tail` MCP tool
// (`mcp-host.ts`): a shell and an agent asking "what did the server just say" get one answer.

// why: Bun exposes no path joiner, and the fix names the logs directory on any platform.
import { join } from 'node:path';
import { isRole, NotImplementedError, ROLES, renderFixShellArg } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { LOGS_DEFAULT_LINES, LOGS_MAX_LINES, logsSpec } from './cmd-logs-spec';
import type { CliCommand, CommandContext } from './command';
import { ok } from './command';
import { BadFlagError } from './errors';
import { parseIntFlag } from './flag-number';
import { logTailPath, type TailSource, tailLines } from './mcp-host';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { resolveServices } from './runtime-bindings';

/** A log on disk: its size and byte ranges, or nothing. `Bun.file` in the shipped command. */
export type LogOpener = (path: string) => Promise<TailSource | undefined>;

const openLog: LogOpener = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? file : undefined;
};

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
    const path = logTailPath(stateDir, role);
    const log = await open(path);
    if (log === undefined) {
      // The MCP tool's answer, word for word in substance: no role writes a log of its own, so the
      // fix is the process that does.
      throw new NotImplementedError({
        cause: `x logs tail without ${path} is not implemented in this build: x dev writes the dev log, and a role writes one only when its output is sent there`,
        fix:
          role === undefined
            ? 'x dev'
            : `mkdir -p ${renderFixShellArg(join(stateDir, 'logs'), '<the logs dir of the path the cause names>')} && x dev --role ${renderFixShellArg(role, '<role>')} > ${renderFixShellArg(path, '<the path the cause names>')} 2>&1`,
      });
    }
    const tail = await tailLines(log, lines);
    return ok('logs', msg('cli.logs.tail', { count: tail.length, path }), {
      lines: tail,
      data: { path, role: role ?? null, lines: [...tail] },
    });
  },
});

export const logsCommand: CliCommand = logsCommandOver(openLog);
