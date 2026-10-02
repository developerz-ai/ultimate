// `progress(done, total, note?)` as a body calls it: a value kept in memory and written to the
// job's row at most once per `PROGRESS_INTERVAL_MS`, with the last value always written before
// the run settles. A loop over a million rows may call it a million times; the queue sees one
// write a second and no event per call.

import type { Clock } from '@ultimat3/core';
import { logger, renderThrowable } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobProgress } from './introspection';
import { MAX_PROGRESS_NOTE_LENGTH, PROGRESS_INTERVAL_MS } from './introspection';

/** What a job body is handed. Synchronous on purpose: reporting progress never awaits the queue. */
export type ProgressFn = (done: number, total: number, note?: string) => void;

export interface ProgressReporter {
  readonly report: ProgressFn;
  /** Wait out the write in flight and write the value still pending. Never rejects. */
  flush(): Promise<void>;
}

export interface ProgressReporterOptions {
  /** One write to the row. A driver with no introspection passes none, and nothing is written. */
  readonly write: ((progress: JobProgress) => Promise<void>) | undefined;
  readonly job: string;
  readonly jobId: string;
  readonly clock?: Clock;
}

export function createProgressReporter(options: ProgressReporterOptions): ProgressReporter {
  const { write } = options;
  let pending: JobProgress | undefined;
  let writing: Promise<void> = Promise.resolve();
  let lastWriteAt = Number.NEGATIVE_INFINITY;

  /** Chained, so two writes never race each other onto the row out of order. */
  const send = (value: JobProgress): void => {
    if (write === undefined) return;
    lastWriteAt = value.at;
    writing = writing
      .then(() => write(value))
      // Progress is a courtesy to whoever is watching: its failure must never fail the job.
      .catch((error: unknown) => {
        logger.warn('jobs.progress.failed', {
          job: options.job,
          jobId: options.jobId,
          error: renderThrowable(error),
        });
      });
  };

  return {
    report(done, total, note) {
      // A count that is not a number is not progress; dropped rather than written as `null`.
      if (!Number.isFinite(done) || !Number.isFinite(total)) return;
      const at = nowMs(options.clock);
      const value: JobProgress = {
        done,
        total,
        at,
        ...(typeof note === 'string' ? { note: note.slice(0, MAX_PROGRESS_NOTE_LENGTH) } : {}),
      };
      if (at - lastWriteAt < PROGRESS_INTERVAL_MS) {
        pending = value;
        return;
      }
      pending = undefined;
      send(value);
    },
    async flush() {
      if (pending !== undefined) {
        const last = pending;
        pending = undefined;
        send(last);
      }
      await writing;
    },
  };
}
