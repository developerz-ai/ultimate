// `x tasks`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-tasks.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const tasksSpec: CommandSpec = {
  name: 'tasks',
  summary: 'cron tasks, their timezone and their next run; fire one now',
  usage: 'x tasks [list|show <name>|run <name>] [--count n] [--production] [--json]',
  requiresApp: true,
  subcommands: ['list', 'show', 'run'],
  defaultSubcommand: 'list',
  flags: [
    {
      name: 'count',
      type: 'string',
      summary: 'show: how many upcoming occurrences to list',
      subcommands: ['show'],
    },
    {
      name: 'production',
      type: 'boolean',
      summary: 'run: fire it where ULTIMATE_ENV resolves production — real work, asked for by name',
      subcommands: ['run'],
    },
  ],
};
