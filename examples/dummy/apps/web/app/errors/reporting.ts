/**
 * Postly's own home for its errors: every report any role makes — a request, a job, a browser via
 * `/_client-errors` — is folded into its `errorFingerprint` group in `x_error_groups`, and the
 * first sighting of a group enqueues `openErrorIssue`. `/admin/errors` reads the same store.
 *
 * Installed BESIDE whatever reporter is already there, never over it: the container chains its
 * `SENTRY_DSN` transport after this one (`configureReporting`), so a deploy with a monitor still
 * groups here. Imported for its effect by `apps/web/api`, which every role loads.
 */

import {
  type ErrorGroupsStore,
  errorGroupsSink,
  memoryErrorGroupsStore,
  postgresErrorGroupsStore,
} from '@ultimat3/admin/error-groups';
import {
  chainErrorReporters,
  configureErrorReporting,
  installedErrorReporter,
  storeMode,
} from '@ultimat3/core';
import { openErrorIssue } from './jobs/open-error-issue';

/** Durable outside `bun test`, by the rule `@postly/db`'s driver follows (`storeMode`). */
export const errorGroups: ErrorGroupsStore =
  storeMode(Bun.env) === 'memory' ? memoryErrorGroupsStore() : postgresErrorGroupsStore();

export const errorSink = errorGroupsSink({ store: errorGroups, onNewGroup: openErrorIssue });

/**
 * Installed in every process but a test's, by the same `storeMode` rule. Under `bun test` a job a
 * test dead-letters on purpose would be reported, group, and enqueue `openErrorIssue` into that
 * test's own queue — an execution every job trace in the suite would then have to discount. The
 * sink itself is tested directly (`reporting.job.test.ts`).
 */
if (storeMode(Bun.env) === 'database') {
  configureErrorReporting({ reporter: chainErrorReporters(installedErrorReporter(), errorSink) });
}
