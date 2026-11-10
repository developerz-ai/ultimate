/**
 * Postly's own home for its errors: every report any role makes — a request, a job, a browser via
 * `/_client-errors` — is folded into its `errorFingerprint` group in `x_error_groups`, and the
 * first sighting of a group enqueues `openErrorIssue`. `/admin/errors` reads the same store.
 *
 * Installed as the `errorReporter` port by `apps/web/runtime.ts` — the one place a backend is
 * swapped. The container chains its `SENTRY_DSN` transport beside it, so a deploy with a monitor
 * still groups here. This module only declares; it installs nothing.
 */

import {
  type ErrorGroupsStore,
  errorGroupsSink,
  memoryErrorGroupsStore,
  postgresErrorGroupsStore,
} from '@ultimat3/admin/error-groups';
import { storeMode } from '@ultimat3/core';
import { openErrorIssue } from './jobs/open-error-issue';

/** Durable outside `bun test`, by the rule `@postly/db`'s driver follows (`storeMode`). */
export const errorGroups: ErrorGroupsStore =
  storeMode(Bun.env) === 'memory' ? memoryErrorGroupsStore() : postgresErrorGroupsStore();

export const errorSink = errorGroupsSink({ store: errorGroups, onNewGroup: openErrorIssue });
