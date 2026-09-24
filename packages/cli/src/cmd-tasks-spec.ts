// `x tasks`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-tasks.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const tasksSpec: CommandSpec = {
  name: 'tasks',
  summary: 'cron tasks, their timezone and their next run',
  usage: 'x tasks [list|show <name>] [--count n] [--json]',
  requiresApp: true,
  subcommands: ['list', 'show'],
  defaultSubcommand: 'list',
  flags: [
    {
      name: 'count',
      type: 'string',
      summary: 'show: how many upcoming occurrences to list',
      subcommands: ['show'],
    },
  ],
};
