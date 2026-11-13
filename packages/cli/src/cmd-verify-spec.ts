// `x verify`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-verify.ts`, which `registry.ts` imports only when the command runs.

import { DEFAULT_BASE_HELP } from './affected-base';
import type { CommandSpec } from './parse';
import { BUDGET_RULE, WORKER_BYTES, WORKER_CEILING, WORKER_FLOOR } from './test-workers';

/**
 * `run` is the gate (and what a bare `x verify` means); `merge` folds CI parts into its verdict;
 * `plan` cuts the gate into those parts, as the matrix a workflow reads.
 */
export const VERIFY_SUBCOMMANDS = ['run', 'merge', 'plan'] as const;

export const verifySpec: CommandSpec = {
  name: 'verify',
  summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
  usage:
    'x verify [--only <step>[,<step>…] [--shard i/n [--timings file]] | --changed [--base <ref>] [--dirty]] [--workers N] [--isolate] [--json] · x verify merge <part.json…> [--json] · x verify plan [--parts n] [--json]',
  // No `requiresApp`: the dispatcher reads it per command, and `plan` reads nothing from an app —
  // ci.yml runs it at the repo root. `run` and `merge` call `requireAppRoot` first, before any
  // flag is read (`cmd-verify.ts`; `cmd-verify-plan.test.ts` holds both sides).
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
      summary: `test processes per parallel step (default: one per ${WORKER_BYTES / 2 ** 30} GiB of a ${BUDGET_RULE} budget, at most one per core; ULTIMATE_TEST_MEMORY_BUDGET and ULTIMATE_TEST_MAX_WORKERS override; min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
    },
    {
      name: 'only',
      type: 'string',
      subcommands: ['run'],
      summary:
        'run the named step(s), comma-separated, in one process — an iteration loop or one CI job, NOT A GATE RUN; the gate is this command with no flag, or `x verify merge` over every job',
    },
    {
      name: 'changed',
      type: 'boolean',
      subcommands: ['run'],
      summary:
        'run only the steps whose inputs the diff touches, each named with the files that chose it (data.changed) — NOT A GATE RUN; never with --only',
    },
    {
      name: 'base',
      type: 'string',
      subcommands: ['run'],
      summary: `with --changed: git ref to diff against, merge-base style, as x affected reads it (default: ${DEFAULT_BASE_HELP})`,
    },
    {
      name: 'dirty',
      type: 'boolean',
      subcommands: ['run'],
      summary: 'with --changed: also count uncommitted and untracked work',
    },
    {
      name: 'shard',
      type: 'string',
      subcommands: ['run'],
      summary:
        'with --only unit|contract|job|live|e2e: run shard i of an n-way split of each step’s sorted file list (round-robin), for one CI job; `x verify merge` checks all n',
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
    {
      name: 'parts',
      type: 'string',
      subcommands: ['plan'],
      summary:
        'runners to cut the gate into: 1, or 4 to 64 (default 4) — data.matrix is a GitHub strategy.matrix, each row an `x verify --only … [--shard i/n]`',
    },
  ],
};
