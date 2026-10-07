// `x jobs`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-jobs.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const JOBS_SUBCOMMANDS = [
  'ls',
  'show',
  'retry',
  'cancel',
  'rm',
  'promote',
  'pause',
  'resume',
  'drain',
] as const;

export const jobsSpec: CommandSpec = {
  name: 'jobs',
  // Never ENDING in "(planned)": that suffix is how `x help` and the planned-table tests tell a
  // planned COMMAND from a shipped one, and `x jobs` ships — only its `drain` does not.
  summary:
    'list, show, retry, cancel, remove and promote jobs; pause and resume a queue (drain is planned)',
  usage:
    'x jobs [ls|show <id>|retry <id>|cancel <id>|rm <id>|promote <id>|pause <queue>|resume <queue>|drain] [--queue q] [--state s] [--name n] [--limit n] [--after cursor] [--from-step name] [--reason text] [--json]',
  requiresApp: true,
  subcommands: JOBS_SUBCOMMANDS,
  // The bare `x jobs` lists; it never retries, cancels or drains anything.
  defaultSubcommand: 'ls',
  flags: [
    { name: 'queue', type: 'string', summary: 'filter by queue name' },
    { name: 'state', type: 'string', summary: 'filter by job state' },
    { name: 'limit', type: 'string', summary: 'max rows to return' },
    { name: 'name', type: 'string', summary: 'filter by job name' },
    {
      name: 'after',
      type: 'string',
      summary: 'ls: the next page — the cursor the previous page printed',
      subcommands: ['ls'],
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
  ],
};
