// `x jobs`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-jobs.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/**
 * One verb each, the same across every `x` registry (#709): `list`, `show <one>`, `delete`. No
 * `ls`/`rm` aliases — two spellings of one verb is the ambiguity axiom 1 forbids.
 */
export const JOBS_SUBCOMMANDS = [
  'list',
  'show',
  'retry',
  'cancel',
  'delete',
  'promote',
  'resolve-step',
  'pause',
  'resume',
  'drain',
] as const;

export const jobsSpec: CommandSpec = {
  name: 'jobs',
  // Never ENDING in "(planned)": that suffix is how `x help` and the planned-table tests tell a
  // planned COMMAND from a shipped one, and `x jobs` ships — only its `drain` does not.
  summary:
    'list, show, retry, cancel, delete and promote jobs; resolve a step; pause and resume a queue (drain is planned)',
  usage:
    'x jobs [list|show <id>|retry <id>|cancel <id>|delete <id>|promote <id>|resolve-step <id> <step>|pause <queue>|resume <queue>|drain] [--queue q] [--state s] [--name n] [--limit n] [--after cursor] [--from-step name] [--reason text] [--ran|--not-ran] [--output json] [--json]',
  requiresApp: true,
  subcommands: JOBS_SUBCOMMANDS,
  // The bare `x jobs` lists; it never retries, cancels or drains anything.
  defaultSubcommand: 'list',
  flags: [
    { name: 'queue', type: 'string', summary: 'filter by queue name' },
    { name: 'state', type: 'string', summary: 'filter by job state' },
    { name: 'limit', type: 'string', summary: 'max rows to return' },
    { name: 'name', type: 'string', summary: 'filter by job name' },
    {
      name: 'after',
      type: 'string',
      summary: 'list: the next page — the cursor the previous page printed',
      subcommands: ['list'],
    },
    // Each of these is read by ONE subcommand — `retryJob`, `cancelJob` — and says so in its own
    // summary. The scope is what makes the parser refuse it anywhere else instead
    // of accepting it and ignoring it: `x db gen --dry-run` parsed and wrote the migration.
    {
      name: 'from-step',
      type: 'string',
      summary: 'retry: drop this step so it re-executes',
      subcommands: ['retry'],
    },
    {
      name: 'reason',
      type: 'string',
      summary: 'cancel: why, recorded on the job',
      subcommands: ['cancel'],
    },
    {
      name: 'ran',
      type: 'boolean',
      summary: 'resolve-step: the step happened — record --output as its answer',
      subcommands: ['resolve-step'],
    },
    {
      name: 'not-ran',
      type: 'boolean',
      summary: 'resolve-step: the step did not happen — the next run calls it again',
      subcommands: ['resolve-step'],
    },
    {
      name: 'output',
      type: 'string',
      summary: 'resolve-step: with --ran, the JSON a replay of the step returns (default null)',
      subcommands: ['resolve-step'],
    },
  ],
};
