// Single responsibility: where a `NatsTransport`'s background failures go, and how often. A FAULT
// (a subscriber that threw, a re-subscribe the server refused) is said every time. An OUTAGE (a
// drop, a refused dial, a client the library gave up on) is one fact however long it lasts: said
// on its 1st, 2nd, 4th, 8th, … failure and once more when the bus answers again.

import { isOutageMilestone, isUltimateError, logger, renderThrowable } from '@ultimat3/core';

export interface NatsReportsOptions {
  readonly transport: string;
  /** The app's own sink. Absent, or throwing, the logger line is written instead. */
  readonly onError: ((error: unknown, subject: string) => void) | undefined;
  /**
   * `'error'` for a process that cannot do its job without the bus (a `sync` node, a replicator);
   * `'warn'` for one that only publishes — degraded, and still serving.
   */
  readonly outageLevel: 'warn' | 'error';
}

export class NatsReports {
  readonly #options: NatsReportsOptions;
  /** Failures of the bus itself since it last answered. */
  #failures = 0;

  constructor(options: NatsReportsOptions) {
    this.#options = options;
  }

  /**
   * Every background failure lands here or in `outage`. Dropping it when the caller passed no
   * handler is what turns "no changes arrive" into a debugging session with nothing to read, so
   * the default emits rather than swallows.
   */
  fault(error: unknown, subject: string): void {
    this.#say(error, subject, 'error');
  }

  /**
   * One more failure of the bus itself, thinned and at the level its owner chose. `always` is for
   * a TRANSITION rather than a retry — the library giving up on a client happens once per client,
   * and it is the line that says the transport's own re-dial took over.
   */
  outage(error: unknown, always = false): void {
    this.#failures += 1;
    if (!always && !isOutageMilestone(this.#failures)) return;
    this.#say(error, this.#options.transport, this.#options.outageLevel, this.#failures);
  }

  /** The bus answers again: one line saying after how many failures, and the count starts over. */
  recovered(): void {
    const after = this.#failures;
    if (after === 0) return;
    this.#failures = 0;
    logger.info('nats transport recovered', { transport: this.#options.transport, after });
  }

  #say(error: unknown, subject: string, level: 'warn' | 'error', failures?: number): void {
    const handler = this.#options.onError;
    if (handler !== undefined) {
      // Total: the handler is injected, and its throw would land in whatever called this — the
      // dial loop (started with `void`: an unhandled rejection and no more retries), the
      // library's status loop, a subscriber's delivery. A reporter that cannot report is not a
      // reason to stop dialling; the fault falls through to the logger line below.
      try {
        handler(error, subject);
        return;
      } catch (thrown) {
        logger.error('nats transport onError threw', { error: renderThrowable(thrown) });
      }
    }
    logger[level]('nats transport error', {
      transport: this.#options.transport,
      subject,
      ...(failures === undefined ? {} : { failures }),
      code: isUltimateError(error) ? error.code : undefined,
      // `renderThrowable`, never `String(error)`: this is a reporter, and a throwable that fights
      // being read makes the report the thing that throws.
      error: renderThrowable(error),
    });
  }
}
