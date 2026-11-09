// Single responsibility: what one `outbound()` CALL tells the instrumentation bus — a client span
// named `outbound.<vendor>` with semconv attributes and one `outbound.request` event, both around
// the whole call (retries and breaker inside), on the answer and on the failure alike.

import { isUltimateError } from './errors';
import { instrument, subscribed } from './instrument';
import { SEMCONV } from './instrument-semconv';
import type { Span } from './telemetry';
import { withSpan } from './telemetry';

export interface OutboundCallSite {
  readonly vendor: string;
  readonly method: string;
  readonly url: URL;
}

/** The status a coded refusal carried (`X_OUTBOUND_REFUSED` and kin); none when no answer came. */
function refusedStatus(error: unknown): number | undefined {
  if (!isUltimateError(error)) return undefined;
  const status = error.meta?.['status'];
  return typeof status === 'number' ? status : undefined;
}

/** Hostname and port only: the path and query may carry a credential, so neither is recorded. */
function serverAttributes(url: URL): Record<string, string | number> {
  const port = url.port === '' ? undefined : Number(url.port);
  return {
    [SEMCONV.serverAddress]: url.hostname,
    ...(port === undefined ? {} : { [SEMCONV.serverPort]: port }),
  };
}

/**
 * Run the call inside its span and report it once it settles. `work` answers the final status; a
 * throw is reported with the status its refusal carried, then rethrown unchanged.
 */
export async function instrumentedCall<T extends { readonly status: number }>(
  site: OutboundCallSite,
  work: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  const report = (status: number | undefined, error?: unknown): void => {
    if (!subscribed('outbound.request')) return;
    instrument('outbound.request', {
      vendor: site.vendor,
      method: site.method,
      host: site.url.hostname,
      ...(status === undefined ? {} : { status }),
      durationMs: performance.now() - started,
      ...(error === undefined ? {} : { error }),
    });
  };
  try {
    const answer = await withSpan(
      `outbound.${site.vendor}`,
      async (span: Span) => {
        try {
          const settled = await work();
          span.setAttribute(SEMCONV.httpResponseStatusCode, settled.status);
          return settled;
        } catch (error) {
          const status = refusedStatus(error);
          if (status !== undefined) span.setAttribute(SEMCONV.httpResponseStatusCode, status);
          throw error;
        }
      },
      {
        kind: 'client',
        attributes: {
          ...serverAttributes(site.url),
          [SEMCONV.httpRequestMethod]: site.method,
          'ultimate.outbound.vendor': site.vendor,
        },
      },
    );
    report(answer.status);
    return answer;
  } catch (error) {
    report(refusedStatus(error), error);
    throw error;
  }
}
