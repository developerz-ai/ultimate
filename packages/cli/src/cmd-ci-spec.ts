// `x ci`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-ci.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** Log lines kept per failed job. Enough to hold a findings block, short enough to read. */
export const TAIL_LINES = 40;

export const ciSpec: CommandSpec = {
  name: 'ci',
  summary: 'the workflow runs for this branch, and the findings inside the failed steps log',
  usage: 'x ci [--branch <name>] [--run <id>] [--repo owner/name] [--tail <n>] [--full] [--json]',
  flags: [
    { name: 'repo', type: 'string', summary: 'owner/name; the checkout own remote by default' },
    { name: 'branch', type: 'string', summary: 'branch to read runs for; this one by default' },
    { name: 'run', type: 'string', summary: 'one run id, instead of this branch latest' },
    {
      name: 'tail',
      type: 'string',
      summary: `log lines kept per failed job (default ${TAIL_LINES})`,
    },
    { name: 'full', type: 'boolean', summary: 'the whole failed-step log, not the tail' },
  ],
};
