// Single responsibility: one condition that KEEPS failing, said rarely — once more when it ends.
// Two shapes of the one limiter: `outageLog` says it on failures 1, 2, 4, 8, …; `failureStreak`
// says it once per CAUSE. An outage is one fact; a line per retry per pod for as long as it lasts
// is the fact buried under itself.

import { renderThrowable } from './error-render';
import { isUltimateError } from './errors';
import { type LogFields, logger } from './logger';

export interface OutageLogOptions {
  /** The line's message while the condition fails. Low cardinality: it is what a monitor groups on. */
  readonly event: string;
  /**
   * `'warn'` for a process that is degraded and still serving (a publisher without its bus).
   * `'error'` for one that cannot do its job (a `sync` node without its bus).
   */
  readonly level: 'warn' | 'error';
}

export interface OutageLog {
  /**
   * One more failure. Written — with `failures`, the count since it last worked — on the 1st,
   * 2nd, 4th, 8th, …; answers whether this one was, so a caller thins a second sink the same way.
   */
  failed(fields?: LogFields): boolean;
  /** It works again: ONE `info` line, `<event> recovered`, with `after`. Silent when nothing had failed. */
  recovered(fields?: LogFields): void;
  /** Failures since it last worked. */
  readonly failures: number;
}

/** True on 1, 2, 4, 8, …: the attempts an outage is said on. */
export function isOutageMilestone(failures: number): boolean {
  return failures > 0 && (failures & (failures - 1)) === 0;
}

export function outageLog(options: OutageLogOptions): OutageLog {
  let failures = 0;
  return {
    get failures(): number {
      return failures;
    },
    failed(fields?: LogFields): boolean {
      failures += 1;
      if (!isOutageMilestone(failures)) return false;
      logger[options.level](options.event, { ...fields, failures });
      return true;
    },
    recovered(fields?: LogFields): void {
      if (failures === 0) return;
      const after = failures;
      failures = 0;
      logger.info(`${options.event} recovered`, { ...fields, after });
    },
  };
}

/**
 * What a failure line carries: the rendered message, and for a coded error the code to search on
 * and the `fix:` to run — what the operator reading the line at 3am needs, not a sentence.
 */
export function failureFields(error: unknown): LogFields {
  const message = renderThrowable(error);
  return isUltimateError(error)
    ? { error: message, code: error.code, cause: error.cause, fix: error.fix }
    : { error: message };
}

export interface FailureStreakOptions {
  /** The line that opens a streak, or changes its cause. Low cardinality: a monitor groups on it. */
  readonly event: string;
  /** The ONE `info` line that ends a streak, with `failures`, its count. */
  readonly recoveredEvent: string;
  /** Default `'error'`: a loop that cannot do its job. `'warn'` for one that retries its way back. */
  readonly level?: 'warn' | 'error';
  /** On every line the streak writes, its end included: what names the loop (`workerId`, `channel`). */
  readonly fields?: LogFields;
}

export interface FailureStreak {
  /**
   * One more failure: logged when it opens a streak or changes its cause, counted otherwise. A new
   * cause — a restart's refusal giving way to a missing column — is news: its line carries the
   * streak it ends (`previous`, with that streak's count). `fields` go on this failure's line only.
   * Answers whether it was logged.
   */
  failed(error: unknown, fields?: LogFields): boolean;
  /** It works again: ends a streak, if one was open, with one line counting it. */
  passed(): void;
  /** The loop (re)started: whatever streak a stopped run left open is not this run's. */
  reset(): void;
  /** Failures in the open streak; 0 when none is. */
  readonly failures: number;
}

interface Cause {
  readonly key: string;
  readonly label: Readonly<Record<string, string>>;
}

/** What makes two failures the same one: the code, or, uncoded, the rendered message. */
function causeOf(error: unknown): Cause {
  if (isUltimateError(error)) return { key: `code:${error.code}`, label: { code: error.code } };
  const message = renderThrowable(error);
  return { key: `error:${message}`, label: { error: message } };
}

export function failureStreak(options: FailureStreakOptions): FailureStreak {
  const level = options.level ?? 'error';
  let failures = 0;
  let cause: Cause | undefined;
  const reset = (): void => {
    failures = 0;
    cause = undefined;
  };
  return {
    get failures(): number {
      return failures;
    },
    failed(error: unknown, fields?: LogFields): boolean {
      const next = causeOf(error);
      if (cause !== undefined && cause.key === next.key) {
        failures += 1;
        return false;
      }
      const previous = cause === undefined ? {} : { previous: { ...cause.label, failures } };
      failures = 1;
      cause = next;
      logger[level](options.event, {
        ...options.fields,
        ...fields,
        ...failureFields(error),
        ...previous,
      });
      return true;
    },
    passed(): void {
      if (failures === 0) return;
      logger.info(options.recoveredEvent, { ...options.fields, failures });
      reset();
    },
    reset,
  };
}
