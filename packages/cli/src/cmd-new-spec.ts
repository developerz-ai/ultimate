// `x new`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-new.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const newSpec: CommandSpec = {
  name: 'new',
  summary: 'scaffold a new Ultimate monorepo that already runs',
  // Every flag the table below declares, in the spelling that turns it off where the default is
  // on: the usage line offered `--no-example` while the table listed `--example`, and a reader
  // had to reconcile the two to answer "which one do I get if I type neither".
  usage: 'x new <name> [--dir path] [--no-example] [--no-git] [--dry-run] [--force] [--json]',
  flags: [
    { name: 'dir', type: 'string', summary: 'parent directory (default: cwd)' },
    {
      // The summary carries the default and the negation because the page has to answer "which
      // one do I get if I type neither": the usage line offered `--no-example`, this table said
      // `--example`, and `default: true` is a field only `--json` renders. 136 files against 109.
      name: 'example',
      type: 'boolean',
      summary: 'include the example feature slice (default: on; --no-example for an empty app/)',
      default: true,
    },
    {
      name: 'git',
      type: 'boolean',
      summary: 'git init and commit the scaffold (default: on; --no-git for a bare directory)',
      default: true,
    },
    { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
    { name: 'force', type: 'boolean', summary: 'write into a directory that already exists' },
  ],
};
