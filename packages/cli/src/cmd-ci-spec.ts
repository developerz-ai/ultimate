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

/** `runs` is the triage `x ci` has always been; `tested` asks whether a push may reuse a PR run. */
export const CI_SUBCOMMANDS = ['runs', 'tested'] as const;

/** How old the green PR run `tested` reuses may be: the runner image and the registry move. */
export const TESTED_MAX_AGE = '24h';

/** The workflow file whose run `tested` reads, when `--workflow` names none. */
export const TESTED_WORKFLOW = 'ci.yml';

export const ciSpec: CommandSpec = {
  name: 'ci',
  summary:
    'the workflow runs for this branch and the findings inside the failed steps log; tested: whether a push reuses a green PR run',
  usage:
    'x ci [runs] [--branch <name>] [--run <id>] [--repo owner/name] [--tail <n>] [--full] [--workflow <name>] [--event <push|pull_request|workflow_dispatch>] [--json] · x ci tested [--max-age 24h] [--repo owner/name] [--workflow ci.yml] [--json]',
  subcommands: CI_SUBCOMMANDS,
  // The bare `x ci` is the triage it always was; `tested` is asked for by name.
  defaultSubcommand: 'runs',
  flags: [
    { name: 'repo', type: 'string', summary: 'owner/name; the checkout own remote by default' },
    {
      name: 'branch',
      type: 'string',
      summary: 'branch to read runs for; this one by default',
      subcommands: ['runs'],
    },
    {
      name: 'run',
      type: 'string',
      summary: 'one run id, instead of this branch latest',
      subcommands: ['runs'],
    },
    {
      name: 'tail',
      type: 'string',
      summary: `log lines kept per failed job (default ${TAIL_LINES})`,
      subcommands: ['runs'],
    },
    {
      name: 'full',
      type: 'boolean',
      summary: 'the whole failed-step log, not the tail',
      subcommands: ['runs'],
    },
    {
      name: 'workflow',
      type: 'string',
      summary: `the workflow name or filename to read (e.g. ci.yml); for tested, the one whose run counts (default ${TESTED_WORKFLOW})`,
    },
    {
      name: 'event',
      type: 'string',
      summary: 'only runs of this event (push, pull_request, workflow_dispatch)',
      subcommands: ['runs'],
    },
    {
      name: 'max-age',
      type: 'string',
      summary: `tested: the oldest PR run still reused (default ${TESTED_MAX_AGE})`,
      subcommands: ['tested'],
    },
  ],
};
