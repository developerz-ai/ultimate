// `x kit`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-kit.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const kitSpec: CommandSpec = {
  name: 'kit',
  summary:
    'write the managed agent kit (.claude/skills, .claude/agents) from the installed framework; app-* files and "off" entries are never touched',
  usage: 'x kit [--json]',
  requiresApp: true,
  flags: [],
};
