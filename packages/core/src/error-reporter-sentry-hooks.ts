// Single responsibility: the adopter's say over what the Sentry transport sends — drop by code,
// sample, regroup, scrub. Functions of the report or the event, decided per report; the envelope
// format stays `error-reporter-sentry.ts`'s alone.

import { renderThrowable } from './error-render';
import type { ErrorReport } from './error-reporter';
import { ConfigInvalidError } from './errors';
import { logger } from './logger';

/** The event payload as the envelope will carry it: the third line, before serialisation. */
export type SentryEvent = Readonly<Record<string, unknown>>;

export interface SentryReporterHooks {
  /**
   * The last word on an event: return it (changed or not) to send, `null` to drop. Scrub by VALUE
   * here — `redactFields` already masked by key. A hook that throws drops the event: an event the
   * scrubber failed on is exactly the one that must not leave unscrubbed.
   */
  readonly beforeSend?: ((event: SentryEvent) => SentryEvent | null) | undefined;
  /** `true` drops every report with this code, before the event is even built. */
  readonly ignore?: ((code: string) => boolean) | undefined;
  /** The monitor's grouping, replacing `errorFingerprint`'s one-element default. */
  readonly fingerprint?: ((report: ErrorReport) => readonly string[]) | undefined;
  /** The share of reports sent, `0..1` inclusive. Default 1: every report. */
  readonly sampleRate?: number | undefined;
  /** `[0, 1)`, the sampling roll. Injected by tests; default `Math.random`. */
  readonly random?: (() => number) | undefined;
}

/** Refused at wiring time, like the DSN: a rate past 1 or below 0 is a monitor nobody configured. */
export function screenSampleRate(rate: number | undefined): number {
  if (rate === undefined) return 1;
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) return rate;
  throw new ConfigInvalidError({
    cause: `sentryErrorReporter sampleRate is ${String(rate)}; it is the share of reports sent, from 0 to 1`,
    fix: 'sentryErrorReporter({ dsn, sampleRate: 0.25 })   # 0..1 inclusive, or omit it to send every report',
    meta: { sampleRate: rate },
  });
}

/**
 * Calls an adopter's hook without letting it throw into `report()`, which runs inside the catch
 * blocks of every failure path. A throwing filter or grouping falls back to the default.
 */
function guarded<T>(hook: string, run: () => T, fallback: T): T {
  try {
    return run();
  } catch (thrown) {
    logger.warn(`error reporter ${hook} threw; the default was used`, {
      error: renderThrowable(thrown),
    });
    return fallback;
  }
}

/** Whether this report is sent at all: the code filter first, then the roll. */
export function admitted(report: ErrorReport, hooks: SentryReporterHooks, rate: number): boolean {
  const { ignore } = hooks;
  if (ignore !== undefined && guarded('ignore', () => ignore(report.code), false)) return false;
  if (rate >= 1) return true;
  return (hooks.random ?? Math.random)() < rate;
}

/** The adopter's grouping, or `undefined` for the default one. */
export function customFingerprint(
  report: ErrorReport,
  hooks: SentryReporterHooks,
): readonly string[] | undefined {
  const { fingerprint } = hooks;
  if (fingerprint === undefined) return undefined;
  return guarded('fingerprint', () => [...fingerprint(report)], undefined);
}

/** `beforeSend`'s verdict, total: a throwing hook is a dropped event and one warn line. */
export function finalEvent(event: SentryEvent, hooks: SentryReporterHooks): SentryEvent | null {
  if (hooks.beforeSend === undefined) return event;
  try {
    return hooks.beforeSend(event);
  } catch (thrown) {
    logger.warn('error reporter beforeSend threw; the event was dropped', {
      error: renderThrowable(thrown),
    });
    return null;
  }
}
