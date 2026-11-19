// `errors.explain`'s rows for the codes of agents sharing a machine and a repository (`error-codes-
// agents.ts`), split out of `mcp-errors.ts` under the 500-line ceiling. Spread into `CLI_FIXES`
// there, whose `Record<CliErrorCode, string>` is still what makes a code without a row a build error.

import type { CliErrorCode } from './error-codes';

export const AGENTS_FIXES = {
  X_PORT_IN_USE: 'x dev --port 3001 --json',
  X_DEV_ALREADY_RUNNING:
    'x dev --json   # after stopping the x dev that already owns this checkout',
  // The path, not `x dev`: the boot has already refused and rerunning it refuses again. The
  // error's own `fix:` carries the resolved `.x/dev.lock`; this table cannot know the state dir.
  X_DEV_LOCK_UNREADABLE: 'rm .x/dev.lock   # then: x dev --json',
  X_UPGRADE_LOCKED: 'cat .x/upgrade.lock',
  X_HEAVY_WAIT_EXPIRED: 'x heavy status --json',
  X_MERGE_UNRESOLVED: 'git diff --name-only --diff-filter=U',
  X_MERGE_DRIVER_UNSET: 'bunx x merge-driver install',
  X_CATALOG_UNPARSEABLE: 'bunx biome check packages/i18n/catalogs',
  X_DOCTOR_PROBE_FAILED: 'bunx x manifest --json',
} as const satisfies Partial<Record<CliErrorCode, string>>;
