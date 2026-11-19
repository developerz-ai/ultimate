// `x clean`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-clean.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const cleanSpec: CommandSpec = {
  name: 'clean',
  summary:
    'remove what test runs leave behind: migrated test templates, .x/cache, stray .x folders, stale probe databases; --services stops the test stack too',
  usage: 'x clean [--dry-run] [--services] [--json]',
  requiresApp: true,
  flags: [
    { name: 'dry-run', type: 'boolean', summary: 'name what would go, remove nothing' },
    {
      name: 'services',
      type: 'boolean',
      summary: "also stop this checkout's test stack, and list the machine's others",
    },
  ],
};
