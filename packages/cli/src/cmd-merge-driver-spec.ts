// `x merge-driver`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-merge-driver.ts`, which `registry.ts` imports only when it runs.

import type { CommandSpec } from './parse';

export const mergeDriverSpec: CommandSpec = {
  name: 'merge-driver',
  summary: 'merges what parallel branches added to the registries; git runs it, setup installs it',
  usage: 'x merge-driver install [--json] · x merge-driver run <base> <ours> <theirs> <path>',
  subcommands: ['install', 'run'],
  flags: [],
};
