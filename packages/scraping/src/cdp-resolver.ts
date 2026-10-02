// A browser RENTED per session: `remoteBrowser({ cdpUrl })` takes a function instead of a string,
// and what the function hands back is acquired once and released exactly once. The framework
// ships no vendor — a provider wrapper is about twenty lines of app code that returns this shape.

import { isUltimateError } from '@ultimat3/core';
import type { MoneyValue } from '@ultimat3/schema';
import { parse, t } from '@ultimat3/schema';
import { cdpResolveFailed } from './error-throws';

export interface CdpResolverRequest {
  /** The scrape's name. */
  readonly scrape: string;
  /** The job run asking — what a provider session is tagged with. Absent outside a job. */
  readonly runId: string | undefined;
  /** The exit this run dials, when it declared one: rent the browser ON it. May carry credentials. */
  readonly egress: string | undefined;
  /** The run's cancellation. A rental still in flight when it aborts is the resolver's to cancel. */
  readonly signal: AbortSignal | undefined;
}

export interface CdpResolution {
  /** The connect URL. Usually carries the provider's access token: it is redacted, never printed. */
  readonly cdpUrl: string;
  /**
   * Hand the browser back. Runs ONCE — in the session's `close()` on success, failure and abort,
   * and straight away when the attach itself fails. A rejection is swallowed: it runs on the way
   * out of a run whose own outcome is the one the reader needs.
   */
  release?(): Promise<void>;
  /** What the rental cost, when the provider says so up front. `Money`, never a float. */
  readonly cost?: MoneyValue | undefined;
}

export type CdpResolver = (request: CdpResolverRequest) => Promise<CdpResolution>;

export interface AcquiredCdp {
  readonly cdpUrl: string;
  readonly cost: MoneyValue | undefined;
  /** The resolution's `release`, latched: the second call does nothing. Never throws. */
  release(): Promise<void>;
}

/** A fixed URL and a resolver, as one shape — so the driver has one attach path, not two. */
export async function acquireCdp(
  source: string | CdpResolver,
  request: CdpResolverRequest,
): Promise<AcquiredCdp> {
  if (typeof source === 'string') {
    return { cdpUrl: source, cost: undefined, release: () => Promise.resolve() };
  }
  let resolution: CdpResolution;
  try {
    resolution = await source(request);
  } catch (thrown) {
    // The resolver's own coded failure keeps its code and its classification; anything else is
    // "no browser to attach to", which is this package's retryable attach failure.
    throw isUltimateError(thrown) ? thrown : cdpResolveFailed(request.scrape, thrown);
  }
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    try {
      await resolution.release?.();
    } catch {
      // See `CdpResolution.release`: a failed hand-back never replaces the run's own outcome.
    }
  };
  try {
    return {
      cdpUrl: resolution.cdpUrl,
      // Parsed, not trusted: the type says `minor: number` and `0.35` satisfies it. A float cost
      // is refused here, before it is added to anything.
      cost: resolution.cost === undefined ? undefined : parse(t.money, resolution.cost),
      release,
    };
  } catch (thrown) {
    await release();
    throw thrown;
  }
}
