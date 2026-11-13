// `x config`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-config.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const CONFIG_SUBCOMMANDS = ['show'] as const;

export const configSpec: CommandSpec = {
  name: 'config',
  summary: 'the resolved app.config.ts, defaults included, credentials redacted',
  usage: 'x config show [--section <key>] [--json]',
  requiresApp: true,
  subcommands: [...CONFIG_SUBCOMMANDS],
  // Read-only, so the bare form may mean it.
  defaultSubcommand: 'show',
  flags: [
    {
      name: 'section',
      type: 'string',
      summary: 'one top-level key of the resolved config (cache, database, auth, …)',
    },
  ],
};
