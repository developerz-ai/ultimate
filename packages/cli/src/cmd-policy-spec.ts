// `x policy`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-policy.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const policySpec: CommandSpec = {
  name: 'policy',
  summary: 'which clause decided a permission, and why',
  usage: 'x policy [list|explain <subject>] [--json]',
  requiresApp: true,
  subcommands: ['list', 'explain'],
  defaultSubcommand: 'list',
};
