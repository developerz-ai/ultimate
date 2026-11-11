// The one refusal the scheduled work owns. The demo reset DELETES content, so it must be able to
// tell the demo's own database from anyone else's — an hourly job that wipes a production table
// because someone pointed this image at it is not a bug you get to find twice.

import { defineError } from '@ultimat3/core/page';

export interface DemoResetUnsafeInit {
  /**
   * The demo's marker rows this store does not hold. Ids, never the connection string: the URL
   * carries a password and this text reaches a log, a dead-letter row and `x jobs show`.
   */
  readonly missing: readonly string[];
}

/**
 * The signal changed in 2026-08 and the code did not — a shipped code is stable forever.
 *
 * It used to refuse whenever `DATABASE_URL` was set, which read as "not the demo" only while the
 * demo had no database at all. `packages/db/src/client.ts` now selects Postgres from that same
 * variable, so the old guard would have refused the deployed demo's every occurrence: three
 * attempts, one dead letter, every hour, forever. What it was actually defending — "do not delete
 * five tables of somebody else's rows" — is now asked directly, of the store. Off-socket: only the
 * job raises it, and no response ever carries it.
 */
export const DemoResetUnsafeError = defineError<DemoResetUnsafeInit>({
  code: 'X_DEMO_RESET_UNSAFE',
  title: 'the demo reset refused to run against a real database',
  offSocket: true,
  cause: (init) =>
    `this database does not hold the demo's seeded accounts (missing ${init.missing.join(', ')}), so it is not the demo's — and resetDemo deletes every post, comment, upload, message and notification before re-seeding`,
  fix: 'delete hourlyDemoReset from apps/web/app/tasks/tasks/hourly-demo-reset.ts if DATABASE_URL points at a database whose rows matter; if this IS the demo, seed it with `bun run packages/db/src/seed.ts` and the next occurrence runs',
  meta: (init) => ({ missing: init.missing }),
});
