// Single responsibility: deliver one OTLP/HTTP body, again when the collector says "not now". A
// rolling restart of a collector answers 503 to every pod at once, and a single-shot POST turned
// each of those answers into a lost window of traces on the surface an operator reads in an outage.

import type { Random } from './backoff';
import { retryAfterSecondsOf } from './client-retry-after';
import { systemClock } from './clock';
import { renderThrowable } from './error-render';
import { UltimateError } from './errors';
import { logger } from './logger';
import { type RetryPolicy, retryLoop } from './retry-loop';

/**
 * The OTLP/HTTP specification's retryable answers, and only those. Not `isRetryableStatus`: that
 * table answers "may a client repeat this call?", and a 500 or a 400 from a validating collector
 * rejects the same batch identically on every attempt.
 */
export const OTLP_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/** Core's curve, the same shape `outbound()` defaults to; `timeoutMs` adds the time budget. */
const OTLP_RETRY_POLICY: Omit<RetryPolicy, 'timeBudgetMs'> = Object.freeze({
  attempts: 3,
  base: 250,
  max: 5_000,
  jitter: 'full',
});

export interface OtlpPostOptions {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The WHOLE export — every attempt and every wait between them — so a batch is held no longer. */
  readonly timeoutMs: number;
  readonly fetch: typeof globalThis.fetch;
  /** Injected so a retry schedule is provable without waiting for one. Defaults to a timer. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** The jitter's die. Defaults to `Math.random`. */
  readonly random?: Random | undefined;
  /** Monotonic ms the budget is measured on. Defaults to the system clock. */
  readonly now?: (() => number) | undefined;
}

/** How one export ended. Every one of them is a log line or silence, never a rejection. */
type Outcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * why: an `UltimateError` only so `retryDecision` can classify it and read the stated delay off
 * `meta.retryAfterSeconds` — `classifyThrown` reads nothing but that brand. It is control flow, the
 * same rule a job's suspension follows: thrown inside `retryLoop`, caught in `postOtlp`, and never
 * seen by a caller or a log line. `X_DRAINING` is the existing core code that means exactly this
 * answer (the responder is restarting or shedding, try again), so no code is minted for a value
 * that cannot escape.
 */
class OtlpRetryable extends UltimateError {
  readonly outcome: Exclude<Outcome, { kind: 'delivered' }>;
  constructor(outcome: Exclude<Outcome, { kind: 'delivered' }>, retryAfterSeconds?: number) {
    super({
      code: 'X_DRAINING',
      cause: 'the OTLP collector asked for this batch again',
      fix: 'postOtlp(request)   # nothing to run: packages/core/src/otlp-post.ts sends the batch again itself',
      retry: retryAfterSeconds === undefined ? 'retryable' : 'retry-after',
      meta: retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    });
    this.outcome = outcome;
  }
}

/**
 * A REF'D wait: it holds the process open, because `timeoutMs` already bounds it and the drain
 * deadline bounds a shutdown. Unref'd, a shutdown flush answered 503 exited mid-wait — the batch
 * lost and its line never printed. The same shape as `retry.ts`'s `abortableTimer`.
 */
const retryTimer = (ms: number): Promise<void> =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

function logOutcome(url: string, outcome: Outcome, attempts: number): void {
  if (outcome.kind === 'rejected') {
    logger.warn('otlp export rejected', { url, status: outcome.status, attempts });
  } else if (outcome.kind === 'failed') {
    logger.warn('otlp export failed', {
      url,
      attempts,
      // `renderThrowable`: the read that renders a caught value must not itself throw, or the
      // export failure this function exists to swallow escapes as an unhandled rejection.
      error: renderThrowable(outcome.error),
    });
  }
}

/**
 * Never throws and never rejects. Telemetry delivery is not the request: a collector that is down
 * must not become the app's outage, and the alternative — an unhandled rejection from a `void`ed
 * promise — takes the process with it on Bun. One line per batch, never per attempt, so a collector
 * that stays down is not also a log flood.
 *
 * `retryLoop`, not `retry()`: `retry()` adopts the ambient request's signal and deadline, and a
 * span batch flushed from inside a request would then die with that request. This send belongs to
 * the process, and its one lifetime is `timeoutMs`.
 */
export async function postOtlp(options: OtlpPostOptions): Promise<void> {
  const now = options.now ?? ((): number => systemClock.monotonic());
  const startedAt = now();
  let attempts = 0;
  const send = async (): Promise<Outcome> => {
    attempts += 1;
    const remaining = Math.max(1, Math.ceil(options.timeoutMs - (now() - startedAt)));
    const signal = AbortSignal.timeout(remaining);
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: 'POST',
        headers: { ...options.headers },
        body: options.body,
        signal,
      });
    } catch (error) {
      // The budget's own abort ends the export: what remained of `timeoutMs` is spent.
      if (signal.aborted) return { kind: 'failed', error };
      throw new OtlpRetryable({ kind: 'failed', error });
    }
    if (response.ok) return { kind: 'delivered' };
    const rejected = { kind: 'rejected', status: response.status } as const;
    if (!OTLP_RETRY_STATUSES.has(response.status)) return rejected;
    const stated = retryAfterSecondsOf(
      response.headers.get('retry-after'),
      response.headers.get('date'),
    );
    throw new OtlpRetryable(rejected, stated);
  };
  let outcome: Outcome;
  try {
    outcome = await retryLoop(
      send,
      { ...OTLP_RETRY_POLICY, timeBudgetMs: options.timeoutMs },
      { sleep: options.sleep ?? retryTimer, now, random: options.random },
    );
  } catch (failure) {
    outcome =
      failure instanceof OtlpRetryable ? failure.outcome : { kind: 'failed', error: failure };
  }
  logOutcome(options.url, outcome, attempts);
}
