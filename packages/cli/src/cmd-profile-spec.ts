// `x profile`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-profile.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const profileSpec: CommandSpec = {
  name: 'profile',
  summary:
    "a CPU profile of rendering one route in-process: the app booted, the route's hottest functions",
  usage: 'x profile <route> [--runs 20] [--top 10] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'runs',
      type: 'string',
      summary: 'requests profiled after one warm-up request (default 20)',
    },
    {
      name: 'top',
      type: 'string',
      summary: 'how many of the hottest functions to report (default 10)',
    },
  ],
};
