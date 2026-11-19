// The `/_x/db` wire between `x db …` and a live `x dev` holding the embedded database: the three
// paths and the `--steps` rule, stated once. Import-free on purpose — the CLI clients read it
// without loading the route's graph, and the dev routes without loading a command's.

/** `x db migrate`, asked of the holder (`db-migrate-through-dev.ts` → `dev-db-migrate.ts`). */
export const DEV_MIGRATE_PATH = '/_x/db/migrate';

/** `x db rollback` (`db-rollback-pass.ts`) and `x db gen`'s ledger read (`db-applied-edits.ts`). */
export const DEV_ROLLBACK_PATH = '/_x/db/rollback';
export const DEV_LEDGER_PATH = '/_x/db/ledger';

/** `--steps` and the door's `?steps=`: one rule, so the holder refuses what the flag refuses. */
export const ROLLBACK_STEPS = {
  name: 'steps',
  command: 'db rollback',
  min: 1,
  example: 'x db rollback --steps 1',
} as const;
