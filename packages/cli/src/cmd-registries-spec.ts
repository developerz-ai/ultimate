// `x actions`, `x queries` and `x entities`' declarations, apart from their body: the parser, `x help`
// and the `errors` step read them without loading `cmd-registries.ts` and the three registries it
// projects, which `registry.ts` imports only when one of the commands runs.

import type { CommandSpec } from './parse';

export const actionsSpec: CommandSpec = {
  name: 'actions',
  summary: 'the action registry: input/output schema, policy, tags, MCP exposure',
  usage: 'x actions [list|describe <name>] [--json]',
  subcommands: ['list', 'describe'],
  defaultSubcommand: 'list',
  requiresApp: true,
};

export const queriesSpec: CommandSpec = {
  name: 'queries',
  summary: 'the query registry: schema, policy, live, cache tags',
  usage: 'x queries [list|describe <name>] [--json]',
  subcommands: ['list', 'describe'],
  defaultSubcommand: 'list',
  requiresApp: true,
};

export const entitiesSpec: CommandSpec = {
  name: 'entities',
  summary: 'the entity registry: columns, invariants, indexes, tenancy',
  usage: 'x entities [list|describe <name>] [--json]',
  subcommands: ['list', 'describe'],
  defaultSubcommand: 'list',
  requiresApp: true,
};
