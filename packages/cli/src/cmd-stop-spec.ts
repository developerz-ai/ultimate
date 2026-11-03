// `x stop`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-stop.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const stopSpec: CommandSpec = {
  name: 'stop',
  summary:
    "stop this checkout's x dev — the pid its .x/dev.lock names, and nothing else — and return once x dev can boot again",
  usage: 'x stop [--timeout 30s] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'timeout',
      type: 'string',
      // No `default:` — the default is the drain's own deadline plus margin, read at run time.
      summary:
        'how long to wait for the drain: 30s, 2m, PT1M (default: the drain deadline plus the release floor plus 5s)',
    },
  ],
};
