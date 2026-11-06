// Single responsibility: `errorGroupsSink` — an `ErrorReporter` that folds every report into its
// `errorFingerprint` group in a store, outside the request's transaction, bounded per minute, and
// enqueues the app's `onNewGroup` job exactly once per new group. It never re-enters the reporter.

import type { Clock, ErrorReport, ErrorReporter } from '@ultimat3/core';
import {
  errorFingerprint,
  finiteCount,
  isRedactedKey,
  logger,
  REDACTED,
  renderThrowable,
  runToCompletion,
  systemClock,
} from '@ultimat3/core';
import { outsideTransaction } from '@ultimat3/db';
import type { JobHandle } from '@ultimat3/jobs';
import type {
  ErrorGroupOccurrence,
  ErrorGroupSample,
  ErrorGroupsStore,
} from './error-groups-store';

/** What `onNewGroup` is enqueued with: enough to title an issue, nothing a report did not group on. */
export interface ErrorGroupNotice {
  readonly fingerprint: string;
  readonly code: string;
  readonly source: string;
  readonly operation: string | null;
  readonly message: string;
  readonly firstSeen: string;
}

export interface ErrorGroupsSinkOptions {
  readonly store: ErrorGroupsStore;
  /** The app's job: which tracker, which title, which assignee are its own (axiom 8). */
  readonly onNewGroup?: Pick<JobHandle<ErrorGroupNotice>, 'name' | 'enqueue'> | undefined;
  /** A report this answers `true` for is not grouped. */
  readonly ignore?: ((report: ErrorReport) => boolean) | undefined;
  /** Store writes per process per minute. Past it, reports are counted and written as one later. */
  readonly perMinute?: number | undefined;
  readonly clock?: Clock | undefined;
}

export interface ErrorGroupsSink extends ErrorReporter {
  /** Resolves when every write started so far has settled. For tests and a drain hook. */
  settled(): Promise<void>;
}

export const ERROR_GROUPS_PER_MINUTE = 120;
/** The cause's head: a list row, never a page of text. */
const MESSAGE_HEAD = 200;
const STACK_MAX = 8_000;
/** Groups held back while over the cap. Past this many, a report is dropped and that is logged. */
const DEFERRED_MAX = 1_000;

/** Credentials by key, as the log line and the monitor envelope redact them: one rule. */
function redactedMeta(meta: ErrorReport['meta']): Readonly<Record<string, unknown>> | null {
  if (meta === undefined) return null;
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(meta))
    out.set(key, isRedactedKey(key) ? REDACTED : value);
  return Object.fromEntries(out);
}

export function sampleOf(report: ErrorReport): ErrorGroupSample {
  return {
    at: new Date(report.at).toISOString(),
    severity: report.severity,
    title: report.title,
    cause: report.cause,
    fix: report.fix,
    release: report.release,
    environment: report.environment,
    requestId: report.scope.requestId ?? null,
    traceId: report.scope.traceId ?? null,
    meta: redactedMeta(report.meta),
    stack: report.stack === undefined ? null : report.stack.slice(0, STACK_MAX),
  };
}

function occurrenceOf(report: ErrorReport, count: number): ErrorGroupOccurrence {
  return {
    fingerprint: errorFingerprint(report),
    code: report.code,
    source: report.source,
    operation: report.scope.operation ?? null,
    message: report.cause.split('\n')[0]?.slice(0, MESSAGE_HEAD) ?? '',
    at: new Date(report.at),
    count,
    sample: sampleOf(report),
  };
}

export function errorGroupsSink(options: ErrorGroupsSinkOptions): ErrorGroupsSink {
  const clock = options.clock ?? systemClock;
  const cap = finiteCount(
    'errorGroupsSink',
    'perMinute',
    options.perMinute ?? ERROR_GROUPS_PER_MINUTE,
    1,
  );
  const deferred = new Map<string, ErrorGroupOccurrence>();
  const pending = new Set<Promise<void>>();
  let window = -1;
  let written = 0;

  /** Its own failure is logged, never reported: a sink that reports itself loops on an outage. */
  const write = (occurrence: ErrorGroupOccurrence): void => {
    const run = outsideTransaction(() =>
      runToCompletion(async () => {
        const { isNew } = await options.store.record(occurrence);
        if (!isNew || options.onNewGroup === undefined) return;
        await options.onNewGroup.enqueue({
          fingerprint: occurrence.fingerprint,
          code: occurrence.code,
          source: occurrence.source,
          operation: occurrence.operation,
          message: occurrence.message,
          firstSeen: occurrence.at.toISOString(),
        });
      }),
    ).catch((failure: unknown) => {
      logger.warn('error group write failed', {
        fingerprint: occurrence.fingerprint,
        code: occurrence.code,
        error: renderThrowable(failure),
      });
    });
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  /** A new minute writes what the last one held back, each group once, before the new report. */
  const turn = (minute: number): void => {
    if (minute === window) return;
    window = minute;
    written = 0;
    const held = [...deferred.values()];
    deferred.clear();
    for (const occurrence of held) {
      written += 1;
      write(occurrence);
    }
  };

  const hold = (occurrence: ErrorGroupOccurrence): void => {
    const seen = deferred.get(occurrence.fingerprint);
    if (seen !== undefined) {
      deferred.set(occurrence.fingerprint, { ...occurrence, count: seen.count + occurrence.count });
    } else if (deferred.size < DEFERRED_MAX) {
      deferred.set(occurrence.fingerprint, occurrence);
    } else {
      logger.warn('error group dropped over the per-minute cap', {
        fingerprint: occurrence.fingerprint,
        perMinute: cap,
      });
    }
  };

  return {
    report(report: ErrorReport): void {
      try {
        if (options.ignore?.(report) === true) return;
        turn(Math.floor(clock.now().getTime() / 60_000));
        const occurrence = occurrenceOf(report, 1);
        if (written >= cap) {
          hold(occurrence);
          return;
        }
        written += 1;
        write(occurrence);
      } catch (failure) {
        logger.warn('error group sink failed', { error: renderThrowable(failure) });
      }
    },
    async settled(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
