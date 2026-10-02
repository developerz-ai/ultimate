// What one run USED, counted where the work happens and reported with its result. A measurement
// and nothing else: no quota, no plan, no ledger — what a number here is worth, and what happens
// when it is too high, is the app's (`docs/idea/19-mechanism-not-convention.md`).

import type { MoneyValue } from '@ultimat3/schema';
import type { ScrapeClock } from './clock';

export interface ScrapeUsage {
  /** Milliseconds the browser session was held, from before `driver.open()` to this report. */
  readonly browserMs: number;
  /** `page.goto()` calls that reached the driver — a refused host or a robots refusal is not one. */
  readonly navigations: number;
  /** Requests the HTTP leg put on the wire, one per redirect hop. */
  readonly httpRequests: number;
  /**
   * Response-body bytes the HTTP leg read. The BROWSER leg's traffic is not in it: this package's
   * CDP port subscribes to requests, not to their sizes, so a figure for it would be a guess.
   */
  readonly bytesIn: number;
  readonly promptsAnswered: number;
  /**
   * What the rented browser cost, as the `CdpResolver` stated it — a `Money` value, never a float.
   * Absent when the driver rented nothing or the provider prices at release.
   */
  readonly browserCost?: MoneyValue | undefined;
}

/**
 * The counting half, handed to a driver as `SessionInit.usage`. `pageOverTarget`, `httpOverFetch`
 * and `recordedHttp` each call it where they already report activity, so a third-party driver
 * built on them counts by passing the meter through and one that is not counts by calling it.
 */
export interface UsageMeter {
  navigation(): void;
  /** One request on the wire. `bytes` is the body read for it — 0 for a hop that was followed. */
  httpRequest(bytes: number): void;
}

export interface RunUsageMeter extends UsageMeter {
  promptAnswered(): void;
  /** The counts so far, with the session's age read from the clock this meter was built on. */
  snapshot(browserCost?: MoneyValue | undefined): ScrapeUsage;
}

/** Built BEFORE `driver.open()`, so the time a rented browser took to arrive is time it was held. */
export function createUsageMeter(clock: ScrapeClock): RunUsageMeter {
  const startedAt = clock.monotonic();
  let navigations = 0;
  let httpRequests = 0;
  let bytesIn = 0;
  let promptsAnswered = 0;
  return {
    navigation(): void {
      navigations += 1;
    },
    httpRequest(bytes: number): void {
      httpRequests += 1;
      bytesIn += bytes;
    },
    promptAnswered(): void {
      promptsAnswered += 1;
    },
    snapshot(browserCost?: MoneyValue | undefined): ScrapeUsage {
      return {
        browserMs: Math.round(clock.monotonic() - startedAt),
        navigations,
        httpRequests,
        bytesIn,
        promptsAnswered,
        ...(browserCost === undefined ? {} : { browserCost }),
      };
    },
  };
}

/** Failed attempts remembered at once. A bound, not a ledger: the oldest goes first. */
const MAX_FAILED_ATTEMPTS = 256;

const failedAttempts = new Map<string, ScrapeUsage>();

/**
 * What a FAILED attempt used, held until its run is settled. A failed run has no report — the
 * job's return value is the only thing the queue hands `onSettled` — and it was billed all the
 * same, so the counts are kept by run id in the worker's own process, which is where the hook runs.
 */
export function rememberFailedUsage(runId: string, usage: ScrapeUsage): void {
  failedAttempts.delete(runId);
  failedAttempts.set(runId, usage);
  while (failedAttempts.size > MAX_FAILED_ATTEMPTS) {
    const oldest = failedAttempts.keys().next();
    if (oldest.done === true) return;
    failedAttempts.delete(oldest.value);
  }
}

/** The last failed attempt's usage for this run, read once: taking it forgets it. */
export function takeFailedUsage(runId: string): ScrapeUsage | undefined {
  const usage = failedAttempts.get(runId);
  failedAttempts.delete(runId);
  return usage;
}
