// The `x db` family's rows of the CLI catalog (`messages.ts` composes them): migrations, seeds,
// backfills, branches, diagnostics. Data only — `msg()` is the one lookup.

export const DB_MESSAGES = {
  'cli.db.backfill.empty': 'no backfill has run against this database yet',
  'cli.db.backfill.listed': '{count} backfill pass(es)',
  /** The empty cell in a `x db backfill --list` column — a value, not a column key. */
  'cli.db.backfill.none': '-',
  'cli.db.backfill.pending': '{count} of {declared} declared backfill(s) never completed',
  'cli.db.backfill.swept': 'every one of {declared} declared backfill(s) has completed',
  // Every action counted, never derived: `count - enqueued` folded a deduped pass into "blocked",
  // so the summary said blocked while `--json` said deduped for the same row — two renderers
  // stating different facts about one run, which is the thing `--json` exists to make impossible.
  'cli.db.backfill.planned':
    '{count} backfill(s): {enqueued} enqueued, {deduped} already live, {blocked} blocked',
  'cli.db.backfill.dryRun': '{count} backfill(s) would run — nothing written without --write',
  'cli.db.branch.ready': 'branch {name} ready',
  'cli.db.branch.dropped': 'branch {name} dropped',
  'cli.db.branch.failed': 'branch command failed',
  'cli.db.branch.listed': '{count} branch(es) of this database',
  'cli.db.branch.none': 'this database has no branch',
  /** The empty cell in an `x db branch list` column — a value, not a column key. */
  'cli.db.branch.unknown': '-',
  'cli.db.diagnostics.done': '{available} of {total} diagnostic section(s) answered',
  'cli.db.diagnostics.section': '{section}: {count} row(s)',
  'cli.db.diagnostics.unavailable': '{section}: unavailable, {code} — {reason}  fix: {fix}',
  'cli.db.gen.failed': 'migration not generated',
  'cli.db.gen.unchanged': 'entities and migrations agree — nothing to generate',
  'cli.db.gen.blocked':
    'nothing was compared — the app did not load ({count} finding(s)); fix them, then run x db gen again',
  // A THIRD outcome, and it is neither of the other two: nothing to generate, but the sidecar the
  // `drift` step reads did move — an edit under `packages/db/src` that implies no DDL. Rendering it
  // as `written` would name a migration nobody can apply; as `unchanged`, it would hide a file this
  // command wrote. `GeneratedFiles.outcome` is what `--json` carries the same distinction on.
  'cli.db.gen.recorded': 'no migration needed — schema hash re-recorded in {file}',
  // The fourth: no DDL and no sidecar moved, but `packages/db/schema/` did — a hand edit repaired,
  // or a framework table that changed under an upgrade. `unchanged` would deny a write the lines
  // below it list, and this command is `X_SCHEMA_DUMP_DRIFT`'s whole `fix:`.
  'cli.db.gen.dumped': 'no migration needed — schema dump rewritten ({count} file(s))',
  'cli.db.gen.written': 'migration {id} generated',
  // Exit 1 and a migration on disk at once: the summary carries the half the exit code hides.
  'cli.db.gen.writtenDumpFailed':
    'migration {id} generated and written — the schema dump was not; do not generate it again',
  'cli.db.migrate.applied': 'migrations applied',
  'cli.db.migrate.failed': 'migration failed',
  'cli.db.reset.done': 'database reset and migrated',
  // Every seed counted per outcome, exactly as the backfill summary is: a replayed seed writes
  // nothing and skips everything, and a total that hid that would make the second run look idle.
  'cli.db.seed.done':
    '{count} seed(s): {inserted} inserted, {updated} updated, {skipped} already stored',
  'cli.db.seed.dryRun': '{count} seed(s) would run — nothing written while --dry-run is set',
  'cli.db.seed.failed': '{failed} of {count} seed(s) failed',
  'cli.db.seed.none': 'no seed matched — nothing to run',
} as const;
