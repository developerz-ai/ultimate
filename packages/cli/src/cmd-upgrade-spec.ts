// `x upgrade`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-upgrade.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const upgradeSpec: CommandSpec = {
  name: 'upgrade',
  summary:
    'move every @ultimat3/* one major in lockstep, raise the Bun floor, install, gate — and name the section to read',
  usage: 'x upgrade [--to <version>] [--dry-run] [--json]',
  // The one command a repository with pins and no `app.config.ts` can still use: `upgrade-root.ts`
  // finds its root, and its report says which check it could run.
  flags: [
    {
      name: 'to',
      type: 'string',
      summary:
        'an exact release inside the next major; over a mixed set, inside the lowest pins’ next major, and only those pins move (default: the next major’s newest)',
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary: 'report the pins, the Bun floor edits and the section; write nothing, run no gate',
    },
  ],
};
