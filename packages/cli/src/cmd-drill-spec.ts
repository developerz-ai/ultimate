// `x drill`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-drill.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const drillSpec: CommandSpec = {
  name: 'drill',
  summary:
    'fault the real services under web and worker processes, and fail on any framework contract that does not hold',
  usage: 'x drill [<name>] [--list] [--budget-ms n] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'list',
      type: 'boolean',
      summary: 'print every drill, its fault and the properties it holds the app to; run nothing',
    },
    {
      name: 'budget-ms',
      type: 'string',
      summary:
        'the request deadline the drills judge against, in place of the one derived from the app; printed in the verdict',
    },
  ],
};
