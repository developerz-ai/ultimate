// `x docs`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-docs.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** Matches printed by default. Enough to choose between, few enough to read all of. */
export const DEFAULT_LIMIT = 5;

export const docsSpec: CommandSpec = {
  name: 'docs',
  summary: 'the framework docs, answered offline from the installed packages',
  usage: 'x docs "<question|topic|symbol>" [--limit <n>] [--json]',
  flags: [
    { name: 'limit', type: 'string', summary: `matches to return (default: ${DEFAULT_LIMIT})` },
  ],
};
