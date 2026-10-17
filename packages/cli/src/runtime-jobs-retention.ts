// `jobs.doneRetentionMs`, `jobs.deadRetentionMs` and `jobs.outboxRetentionMs`, out of the config `startServices` loads once
// (`app-config-load.ts`), as the windows the `x_jobs` and `x_outbox` purge targets are built with. The
// `notify` windows' sibling (`runtime-notify-retention.ts`), with one difference: these DEFAULT,
// because a finished job is bookkeeping and an unread message is not.

import type { AppConfig, PgExecutor } from '@ultimat3/core';
import {
  JOBS_DEAD_RETENTION_MS_DEFAULT,
  JOBS_DONE_RETENTION_MS_DEFAULT,
  JOBS_OUTBOX_RETENTION_MS_DEFAULT,
} from '@ultimat3/core';
import type { PurgeTarget } from '@ultimat3/jobs';
import { jobsPurgeTarget, outboxPurgeTarget } from '@ultimat3/jobs';

export interface JobsRetention {
  readonly doneRetentionMs: number;
  readonly deadRetentionMs: number;
  readonly outboxRetentionMs: number;
}

/**
 * The app's windows, or core's defaults for a boot with no config file — the same numbers
 * `defineConfig` fills in, so an app without `app.config.ts` keeps finished jobs exactly as long as
 * one that never wrote the keys. Core's validator already refused a window that is not a whole
 * positive number of milliseconds.
 */
export function jobsRetentionOf(config: AppConfig | undefined): JobsRetention {
  return {
    doneRetentionMs: config?.jobs.doneRetentionMs ?? JOBS_DONE_RETENTION_MS_DEFAULT,
    deadRetentionMs: config?.jobs.deadRetentionMs ?? JOBS_DEAD_RETENTION_MS_DEFAULT,
    outboxRetentionMs: config?.jobs.outboxRetentionMs ?? JOBS_OUTBOX_RETENTION_MS_DEFAULT,
  };
}

/** The two queue-table targets `installRetentionSweep` takes, over the boot's own executor. */
export function jobsRetentionTargets(
  executor: PgExecutor,
  config: AppConfig | undefined,
): { readonly jobs: PurgeTarget; readonly outbox: PurgeTarget } {
  const windows = jobsRetentionOf(config);
  return {
    jobs: jobsPurgeTarget({
      executor,
      doneRetentionMs: windows.doneRetentionMs,
      deadRetentionMs: windows.deadRetentionMs,
    }),
    outbox: outboxPurgeTarget({ executor, publishedRetentionMs: windows.outboxRetentionMs }),
  };
}
