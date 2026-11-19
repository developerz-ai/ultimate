// `x heavy`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-heavy.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const heavySpec: CommandSpec = {
  name: 'heavy',
  summary:
    "the machine's shared memory ledger: who is running, who is queued, and any command run inside it",
  usage: 'x heavy [status] [--json] · x heavy run [--label s] [--mb n] [--json] -- <command…>',
  subcommands: ['status', 'run'],
  defaultSubcommand: 'status',
  passthrough: true,
  flags: [
    {
      name: 'label',
      type: 'string',
      summary: 'what other waiters see this run called (default: the command)',
      subcommands: ['run'],
    },
    {
      name: 'mb',
      type: 'string',
      summary: 'the memory to reserve, its measured peak (default: a whole-repo typecheck)',
      subcommands: ['run'],
    },
  ],
};
