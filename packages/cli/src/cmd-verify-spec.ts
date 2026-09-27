// `x verify`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-verify.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';
import { WORKER_BYTES, WORKER_CEILING, WORKER_FLOOR } from './test-workers';

/** `run` is the gate (and what a bare `x verify` means); `merge` folds CI parts into its verdict. */
export const VERIFY_SUBCOMMANDS = ['run', 'merge'] as const;

export const verifySpec: CommandSpec = {
  name: 'verify',
  summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
  usage:
    'x verify [--only <step>[,<step>…] [--shard i/n [--timings file]]] [--workers N] [--isolate] [--json] · x verify merge <part.json…> [--json]',
  requiresApp: true,
  subcommands: VERIFY_SUBCOMMANDS,
  defaultSubcommand: 'run',
  // `--workers` and `--isolate` change how the test steps run, never which steps run. `--only`
  // runs the steps it names and says so in both renderers — never silently, which is the whole
  // of what makes it safe to have. `--shard` narrows further, and only `merge` turns shards back
  // into a gate verdict.
  flags: [
    {
      name: 'workers',
      type: 'string',
      subcommands: ['run'],
      summary: `test processes per parallel step (default: one per ${WORKER_BYTES / 2 ** 30} GiB of a min(4 GiB, 25% of RAM) budget, at most one per core; ULTIMATE_TEST_MEMORY_BUDGET and ULTIMATE_TEST_MAX_WORKERS override; min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
    },
    {
      name: 'only',
      type: 'string',
      subcommands: ['run'],
      summary:
        'run the named step(s), comma-separated, in one process — an iteration loop or one CI job, NOT A GATE RUN; the gate is this command with no flag, or `x verify merge` over every job',
    },
    {
      name: 'shard',
      type: 'string',
      subcommands: ['run'],
      summary:
        'with --only unit|contract|job: run shard i of an n-way split of each step’s sorted file list (round-robin), for one CI job; `x verify merge` checks all n',
    },
    {
      name: 'timings',
      type: 'string',
      subcommands: ['run'],
      summary:
        'with --shard: a bun --timings JSON ({ "path": ms }) — split greedy longest-first instead of round-robin',
    },
    {
      name: 'isolate',
      type: 'boolean',
      subcommands: ['run'],
      summary:
        'a fresh global per test file (bun test --isolate) — off by default since 22.7; x.verify.json "isolate": true makes it the repo default',
    },
  ],
};
