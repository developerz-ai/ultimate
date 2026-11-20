// `errors.explain`'s rows for the codes `error-codes-doctor.ts` owns: `x doctor`'s warnings and
// the upgrade's, split out of `mcp-errors.ts` under the 500-line ceiling. Spread into `CLI_FIXES`
// there, whose `Record<CliErrorCode, string>` makes a code without a row a build error.

import type { CliErrorCode } from './error-codes';

export const DOCTOR_FIXES = {
  X_EXERCISE_UNPROVEN_ABOVE_FLOOR:
    'x exercise --json   # re-measures at the constant seed the gate runs (a floor from before 31.47.0 was measured under random seeds); each unproven record in .x/exercise.json names the proof and its reason: fix the seed helper or override it names, assuming no order between sized calls; the floor only falls',
  X_ENV_NAME_RESERVED:
    'edit app.config.ts: add an APP_ prefix to the envSchema name the finding cites (or delete it where the value is meant for the framework); then: x env example --json && x doctor --json',
  X_FRAMEWORK_PIN_RANGE:
    'x doctor --json   # each X_FRAMEWORK_PIN_RANGE names a package.json line and the exact version: write it there, then: bun install',
  X_VERIFY_STEP_UNFLOORED:
    'x doctor --json   # its X_VERIFY_STEP_UNFLOORED fix names the steps: run that x verify --only, then add each step that passed, not skipped, to "steps" in x.verify.json',
  X_DB_ROW_SECURITY_OFF:
    'database: { rowSecurity: true }   # in defineConfig, app.config.ts; then: x db gen "row security" --json && x db migrate --json && x doctor --json',
  X_DB_INDEX_UNDECLARED:
    'x verify --only drift --json   # each X_DB_INDEX_UNDECLARED warning names the index: its DROP INDEX CONCURRENTLY IF EXISTS "<name>"; goes in a new hand-written migration (-- transaction: false), or declare it in the entity\'s indexes: [...] and x db gen "<change>"',
  X_SHIPPED_GUARD_MISSING:
    "x doctor --json   # each X_SHIPPED_GUARD_MISSING warning's fix is the command that writes its guard, then x verify --only boundaries --json",
  X_SUPERSEDED_WORKAROUND:
    'x doctor --json   # each finding names the file, the release that retired the workaround and its replacement',
  X_GUARD_VENDORED: 'x upgrade --json',
  X_ADVISORY_FLOOR_UNMET: 'bun update source-map-js immutable',
  X_UPGRADE_CODEMODS_PENDING: 'x upgrade codemods --from 0.0.0 --json',
} as const satisfies Partial<Record<CliErrorCode, string>>;
