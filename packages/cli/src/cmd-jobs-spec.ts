// `x jobs`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-jobs.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const JOBS_SUBCOMMANDS = ['ls', 'show', 'retry', 'cancel', 'drain'] as const;

/**
 * The drivers a drain may move work ONTO — every one of them durable, and that is the whole rule.
 * Closed, and read three ways: the flag summary, the refusal, and the `memory` case below.
 */
export const DRAIN_TARGETS = ['redis', 'nats'] as const;

export const jobsSpec: CommandSpec = {
  name: 'jobs',
  summary: 'list, show, retry, cancel and drain the job queue',
  usage:
    'x jobs [ls|show <id>|retry <id>|cancel <id>|drain --to <driver>] [--queue q] [--state s] [--limit n] [--from-step name] [--reason text] [--to driver] [--dry-run] [--json]',
  requiresApp: true,
  subcommands: JOBS_SUBCOMMANDS,
  // The bare `x jobs` lists; it never retries, cancels or drains anything.
  defaultSubcommand: 'ls',
  flags: [
    { name: 'queue', type: 'string', summary: 'filter by queue name' },
    { name: 'state', type: 'string', summary: 'filter by job state' },
    { name: 'limit', type: 'string', summary: 'max rows to return' },
    { name: 'name', type: 'string', summary: 'filter by job name' },
    // Each of these is read by ONE subcommand — `retryJob`, `cancelJob`, `runDrain` — and says
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
      summary: `drain: target driver — ${DRAIN_TARGETS.join(', ')}`,
      subcommands: ['drain'],
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary: 'drain: report the plan, move nothing',
      subcommands: ['drain'],
    },
  ],
};
