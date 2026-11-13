// `x cache`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-cache.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** `stats` stays listed and answers X_NOT_IMPLEMENTED (`PLANNED_SUBCOMMANDS`): hits live in a server. */
export const CACHE_SUBCOMMANDS = ['graph', 'bust', 'clear', 'stats'] as const;

export const cacheSpec: CommandSpec = {
  name: 'cache',
  summary: 'the tag graph (what each write evicts), and a bust of one tag or of every tag',
  usage: 'x cache graph [--tag <tag>] · x cache bust <tag> · x cache clear [--json]',
  requiresApp: true,
  subcommands: [...CACHE_SUBCOMMANDS],
  // Read-only, so the bare form may mean it; `bust` and `clear` are typed or not run.
  defaultSubcommand: 'graph',
  flags: [
    {
      name: 'tag',
      type: 'string',
      summary: 'graph: one tag only — the blast radius of a write that names it',
      subcommands: ['graph'],
    },
  ],
};
