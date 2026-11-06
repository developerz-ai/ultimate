// `x impact`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-impact.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const impactSpec: CommandSpec = {
  name: 'impact',
  summary:
    'what an edit to a file, primitive or entity reaches: routes, actions, queries, jobs, MCP tools, published operations, tests, budgets',
  usage: 'x impact <file|primitive|entity> [--json]',
  requiresApp: true,
  flags: [],
};
