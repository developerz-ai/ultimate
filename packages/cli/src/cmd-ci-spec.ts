// `x ci`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-ci.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** Log lines kept per failed job. Enough to hold a findings block, short enough to read. */
export const TAIL_LINES = 40;

/**
 * The events `--event` accepts, closed: `cmd-ci.ts` refuses every other value against this same
 * constant, so the summary, the refusal and the `gh` filter can never name different sets.
 */
export const CI_EVENTS = ['push', 'pull_request', 'workflow_dispatch'] as const;

export const ciSpec: CommandSpec = {
  name: 'ci',
  summary: 'the workflow runs for this branch, and the findings inside the failed steps log',
  usage:
    'x ci [--branch <name>] [--run <id>] [--repo owner/name] [--tail <n>] [--full] [--workflow <name>] [--event <push|pull_request|workflow_dispatch>] [--json]',
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
    {
      name: 'workflow',
      type: 'string',
      summary: 'only this workflow name or filename (e.g. ci.yml)',
    },
    {
      name: 'event',
      type: 'string',
      summary: 'only runs of this event (push, pull_request, workflow_dispatch)',
    },
  ],
};
