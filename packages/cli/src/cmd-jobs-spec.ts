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

/**
 * The drivers a drain may move work ONTO — every one of them durable, and that is the whole rule.
 * Closed, and read three ways: the flag summary, the refusal, and the `memory` case below. EMPTY:
 * `drain` is planned (`PLANNED_SUBCOMMANDS`) because no durable second driver ships — 25.0.0
 * deleted both all-throw stubs, `nats` and `redis`. A real driver adds itself here.
 */
export const DRAIN_TARGETS: readonly string[] = [];

export const jobsSpec: CommandSpec = {
  name: 'jobs',
  // Never ENDING in "(planned)": that suffix is how `x help` and the planned-table tests tell a
  // planned COMMAND from a shipped one, and `x jobs` ships — only its `drain` does not.
  summary:
    'list, show, retry, cancel, remove and promote jobs; pause and resume a queue (drain is planned)',
  usage:
    'x jobs [ls|show <id>|retry <id>|cancel <id>|rm <id>|promote <id>|pause <queue>|resume <queue>|drain --to <driver>] [--queue q] [--state s] [--name n] [--limit n] [--after cursor] [--from-step name] [--reason text] [--to driver] [--dry-run] [--json]',
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
    // Each of these is read by ONE subcommand — `retryJob`, `cancelJob`, the parked drain — and says
    // so in its own summary. The scope is what makes the parser refuse it anywhere else instead
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
      name: 'to',
      type: 'string',
      summary: `drain (planned): target driver — ${DRAIN_TARGETS.length === 0 ? 'none ships yet' : DRAIN_TARGETS.join(', ')}`,
      subcommands: ['drain'],
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary: 'drain (planned): report the plan, move nothing',
      subcommands: ['drain'],
    },
  ],
};
