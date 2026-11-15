// `x upgrade`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-upgrade.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** `run` is the hop (a bare `x upgrade`); `codemods` applies the installed release's codemods. */
export const UPGRADE_SUBCOMMANDS = ['run', 'codemods'] as const;

export const upgradeSpec: CommandSpec = {
  name: 'upgrade',
  summary:
    'move every @ultimat3/* one major in lockstep, raise the Bun floor, install, apply codemods, gate — and name the section to read',
  usage:
    'x upgrade [--to <version>] [--dry-run] [--json] · x upgrade codemods --from <version> [--to <version>] [--dry-run] [--json]',
  // The one command a repository with pins and no `app.config.ts` can still use: `upgrade-root.ts`
  // finds its root, and its report says which check it could run. `codemods` needs the app.
  subcommands: UPGRADE_SUBCOMMANDS,
  defaultSubcommand: 'run',
  flags: [
    {
      name: 'to',
      type: 'string',
      summary:
        'an exact release inside the next major; over a mixed set, inside the lowest pins’ next major, and only those pins move (default: the next major’s newest). With codemods: the last release whose codemods run (default: this CLI’s own)',
    },
    {
      name: 'from',
      type: 'string',
      subcommands: ['codemods'],
      summary:
        'the release the app came from: the codemods whose version lies after it, up to --to, run',
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary:
        'report the pins, the Bun floor edits, the codemods and the section; write nothing, run no gate',
    },
  ],
};
