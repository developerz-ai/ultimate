// The run's event stream — and it goes through `@ultimat3/core`'s `Logger`, which `Ctx` already
// carries. This package ships CALL SITES and a FIELD VOCABULARY; it ships no sink, no transport
// and no second logger. Where the lines go is the app's existing logger configuration (axiom 1:
// one way to do each thing, and logging already has one).
//
// The event stream is the observability model: a debug report, an operator asking "where did it
// stop", and any future recovery pass all read the same lines. So every step emits start, then
// exactly one of success or failure, with its duration.
//
// What may be in a field is a CLOSED type. That is the mechanism that keeps a session cookie out
// of a log line: `ScrapeEventFields` has no key to put one in, and core's logger redacts the
// remaining spellings by key and every `Secret` by value.

import type { Logger } from '@ultimat3/core';
import type { ScrapeClock } from './clock';
import { errorCode } from './failures';

export interface ScrapeEventFields {
  readonly scrape?: string | undefined;
  readonly runId?: string | undefined;
  readonly attempt?: number | undefined;
  readonly step?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly rows?: number | undefined;
  readonly driver?: string | undefined;
  readonly url?: string | undefined;
  readonly code?: string | undefined;
  /** Shape of a session, never its content — `sessionDigest()` builds these. */
  readonly session?: string | undefined;
  readonly cookies?: number | undefined;
  readonly storageKeys?: number | undefined;
  readonly origin?: string | undefined;
  readonly refused?: number | undefined;
  readonly reused?: boolean | undefined;
  readonly burned?: boolean | undefined;
}

/** One child logger per run, so every line downstream carries the run's identity unasked. */
export const scrapeLogger = (logger: Logger, fields: ScrapeEventFields): Logger =>
  logger.child({ ...fields, component: 'scrape' });

export interface StepEvent {
  readonly name: string;
  readonly logger: Logger;
  readonly clock: ScrapeClock;
  readonly attempt?: number | undefined;
}

/**
 * Start, then exactly one of success or failure, with a duration. The failure line carries the
 * error's CODE and never its message: a code is stable, greppable and safe, and a message is
 * whatever a site put in its HTML.
 */
export async function withStepEvent<T>(event: StepEvent, run: () => Promise<T>): Promise<T> {
  const startedAt = event.clock.monotonic();
  event.logger.debug('scrape.step.start', { step: event.name, attempt: event.attempt });
  try {
    const result = await run();
    event.logger.info('scrape.step.ok', {
      step: event.name,
      attempt: event.attempt,
      durationMs: Math.round(event.clock.monotonic() - startedAt),
    });
    return result;
  } catch (thrown) {
    event.logger.warn('scrape.step.failed', {
      step: event.name,
      attempt: event.attempt,
      durationMs: Math.round(event.clock.monotonic() - startedAt),
      code: errorCode(thrown),
    });
    throw thrown;
  }
}
