// `x logs`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-logs.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const LOGS_SUBCOMMANDS = ['tail'] as const;

/** Lines a bare `x logs tail` prints: a screen, not a history. */
export const LOGS_DEFAULT_LINES = 100;
/** The most one call returns — `tailLines` stops reading at 1 MiB from the end either way. */
export const LOGS_MAX_LINES = 10_000;

export const logsSpec: CommandSpec = {
  name: 'logs',
  summary:
    'the last lines of the dev log, or of one role log, as the logs.tail MCP tool reads them',
  usage: 'x logs tail [--lines n] [--role <role>] [--json]',
  requiresApp: true,
  subcommands: [...LOGS_SUBCOMMANDS],
  // Read-only, so the bare form may mean it.
  defaultSubcommand: 'tail',
  flags: [
    {
      name: 'lines',
      type: 'string',
      summary: `how many lines from the end, 1 to ${LOGS_MAX_LINES} (default ${LOGS_DEFAULT_LINES})`,
    },
    {
      name: 'role',
      type: 'string',
      summary: 'read .x/logs/<role>.log instead of the dev log (web, worker, scheduler, sync, …)',
    },
  ],
};
