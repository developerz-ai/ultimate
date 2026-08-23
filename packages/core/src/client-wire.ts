/**
 * What a typed client puts on the wire and reads back off it: the W3C trace header, the
 * problem+json body, and the immutable answer one dispatch hands to every caller sharing it.
 *
 * Tier 0 because `@ultimat3/action` and `@ultimat3/query` need this identical file and are both
 * tier 3, so neither may import the other — the shape `canonical-json.ts` is already here for.
 * It shipped as a byte-identical copy in each, policed by a `client-twin.test.ts` in both; a test
 * that makes drift LOUD is not the same as a file that cannot drift.
 */

import type { ErrorRetry } from './error-retry';
import { declaredErrorRetry } from './error-retry';
import { isJsonObject } from './json-object';
import { isRetryableStatus } from './retryable-status';
import { currentSpanContext, traceparent } from './telemetry';

/**
 * One dispatch's answer, and deliberately not a `Response`: a deduped read hands its answer to
 * every joiner, so what they share is the immutable TEXT and each parses its own object. A
 * `Response` carries a single-use stream, and a parsed body is a mutable object two callers would
 * then be holding one of.
 */
export interface WireAnswer {
  readonly status: number;
  readonly text: string;
}

/** A `traceparent` is `00-<32 hex>-<16 hex>-<2 hex>`, and nothing else may be sent as one. */
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/**
 * The current trace, as the W3C header — or nothing at all. `currentSpanContext()` answers with
 * an empty `spanId` when a request context exists but no span is active, and `00-<trace>--01` is
 * a header every collector drops, so an incomplete context sends none. In a browser there is no
 * ambient context and this is always empty, which is also what keeps a cross-origin call from
 * acquiring a CORS preflight it did not have.
 */
export function traceHeaders(): Record<string, string> {
  const context = currentSpanContext();
  if (context === undefined) return {};
  if (!TRACE_ID.test(context.traceId) || !SPAN_ID.test(context.spanId)) return {};
  return { traceparent: traceparent(context) };
}

/**
 * A framework code, spelled the one way codes are spelled. `typeof code === 'string'` alone
 * accepted `""` and `"error"` — a gateway's JSON body became an `UltimateError` whose code
 * nothing in the framework or the app declares, rendering `: ` under a humanised title.
 */
export const FRAMEWORK_CODE = /^X_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * `application/problem+json`, or nothing when a proxy answered instead of the app. Total by
 * construction: a gateway's HTML, an empty body and a truncated stream are all "no problem here",
 * never a `SyntaxError` thrown out of the failure path.
 */
export function problemOf(text: string): Record<string, unknown> {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  return isJsonObject(body) ? body : {};
}

/**
 * The classification a failure off the wire carries, or `undefined` to leave the code's own
 * standing. The STATUS decides only when nobody has declared one for the code: a 503 is the
 * canonical "send it again", but `X_NOT_IMPLEMENTED` behind a 501 and a config fault behind a 500
 * are permanent answers somebody already gave, and a status that overrode them would have a client
 * hammer a service that will refuse it identically forever.
 *
 * `UltimateError` fills `retry` from `retryFor(code)` otherwise, which fails closed to `terminal` —
 * so before this every 502 out of a typed client read as "never try again", on the one field the
 * framework promises a client never has to infer.
 */
export function retryForStatus(code: string, status: number): ErrorRetry | undefined {
  if (declaredErrorRetry(code) !== undefined) return undefined;
  return isRetryableStatus(status) ? 'retryable' : undefined;
}
