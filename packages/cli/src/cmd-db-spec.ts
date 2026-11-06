// `x db`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-db.ts`, which `registry.ts` imports only when the command runs.

import { BRANCH_SUBCOMMANDS } from './db-branch';
import type { CommandSpec } from './parse';

export const DB_SUBCOMMANDS = [
  'gen',
  'migrate',
  'reset',
  'seed',
  'studio',
  'branch',
  'backfill',
  'diagnostics',
  'recount',
] as const;

export const dbSpec: CommandSpec = {
  name: 'db',
  summary: 'gen, migrate, reset, seed, studio, branch, backfill, diagnostics, recount',
  usage:
    'x db gen "add publish_at" | migrate | reset | seed [<name>] [--tier reference|dev] [--dry-run] | seed --generate [--rows n] [--seed n] [--dry-run] | studio | branch list | branch create <name> | branch delete <name> | backfill [<name>|--all] [--write] [--force] | backfill --pending | backfill --list [--name n] [--status s] [--limit n] | diagnostics [--limit n] | recount <entity>.<column> [--write]',
  requiresApp: true,
  subcommands: DB_SUBCOMMANDS,
  // Declared from the constant `runBranchCommand` validates against, never a second literal: it
  // is what lets the `errors` step resolve `x db branch list` — a fix line three shipped errors
  // hand out, which read `ls` as a branch name and cloned a database until 1.2.x.
  subcommandPositionals: { branch: BRANCH_SUBCOMMANDS },
  // Each flag whose summary begins `<subcommand>:` declares that scope, and the parser refuses
  // it anywhere else: `x db gen --dry-run` used to parse, reach `runGen` and WRITE the
  // migration. `cmd-db.test.ts` pins summary and scope to the same fact.
  flags: [
    {
      name: 'name',
      type: 'string',
      summary: 'migration, branch or seed name, or backfill to filter',
    },
    {
      name: 'tier',
      type: 'string',
      summary: 'seed: which tier to run — reference or dev; also ULTIMATE_SEED_TIER',
      subcommands: ['seed'],
    },
    {
      name: 'dry-run',
      type: 'boolean',
      summary: 'seed: report what each seed would write, and write nothing',
      subcommands: ['seed'],
    },
    // Rows for every table off the entity declarations, with no seed written: the seed graph
    // `x exercise` runs on. Fixture data, so `dev` only; production is refused whatever the tier.
    {
      name: 'generate',
      type: 'boolean',
      summary: 'seed: generated dev rows for every entity, parents first; never in production',
      subcommands: ['seed'],
    },
    {
      name: 'rows',
      type: 'string',
      summary: 'seed: with --generate, rows per table (per tenant when tenant-scoped; default 3)',
      subcommands: ['seed'],
    },
    {
      name: 'seed',
      type: 'string',
      summary: 'seed: with --generate, the integer the graph is drawn from — same seed, same rows',
      subcommands: ['seed'],
    },
    {
      name: 'list',
      type: 'boolean',
      summary: 'backfill: print the x_backfills ledger',
      subcommands: ['backfill'],
    },
    {
      name: 'pending',
      type: 'boolean',
      summary: 'backfill: declared minus completed; non-zero exit when anything is unswept',
      subcommands: ['backfill'],
    },
    {
      name: 'all',
      type: 'boolean',
      summary: 'backfill: every pending sweep, isolated per name',
      subcommands: ['backfill'],
    },
    {
      name: 'write',
      type: 'boolean',
      summary: 'backfill, recount: enqueue the pass, or set drifted counters; dry run without it',
      subcommands: ['backfill', 'recount'],
    },
    {
      name: 'force',
      type: 'boolean',
      summary: 'backfill: sweep a name the ledger records as completed, as a NEW ledger row',
      subcommands: ['backfill'],
    },
    {
      name: 'status',
      type: 'string',
      summary: 'backfill: filter by running, completed or failed',
      subcommands: ['backfill'],
    },
    {
      name: 'limit',
      type: 'string',
      summary:
        'backfill, diagnostics: max ledger rows, or rows per diagnostics section (default 20)',
      subcommands: ['backfill', 'diagnostics'],
    },
    // Declared because `X_MIGRATION_IRREVERSIBLE`'s own fix line names it. A `fix:` is copied
    // and run verbatim, so a flag the parser refuses would make the error unfollowable.
    {
      name: 'allow-destructive',
      type: 'boolean',
      summary: 'let x db gen emit a drop whose down cannot restore the rows',
    },
    // Declared because `X_MIGRATION_ROLLING_UNSAFE`'s own fix line names it.
    {
      name: 'rolling-unsafe',
      type: 'boolean',
      summary:
        'let x db gen drop a column never retired, for an app that stops before it starts: one instance, or strategy: Recreate',
    },
  ],
};
