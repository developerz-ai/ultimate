/**
 * One dispatch of a `clientTransport` request: the `RequestInit`, the fence's abort for a read,
 * the network fault's code, and the ok/error split — nothing about how many times it happens
 * (the flight's) or what the answer means (the transport's).
 */

import type { ClientFlight, ClientRetry } from './client-flight';
import { problemError, transportFailed } from './client-problem';
import { onRescope } from './client-scope';
import { scopeChanged } from './client-scope-error';
import type { UltimateError } from './errors';
import type { RecordEnvelope } from './record-envelope';
import { RECORDS_HEADER } from './record-envelope';
import { outboundSlot, pageClient } from './record-sink';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The header `@ultimat3/action`'s server reads to replay rather than re-run a write. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export interface TransportRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  /** JSON-encoded, with `content-type: application/json`. */
  readonly body?: unknown;
  /**
   * Sent VERBATIM instead of `body` — bytes to a signed URL. No default header is added (a signed
   * request may cover them), and the answer is not decoded: the call resolves `undefined`.
   */
  readonly rawBody?: BodyInit | undefined;
  /** Spread LAST, so an explicit value wins over every default. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly idempotencyKey?: string | undefined;
  /** Dedup, retry, deadline and a concurrency ceiling — opt-in; a read dedupes only with one. */
  readonly flight?: ClientFlight | undefined;
  /** Refuse to join a read that left before this call did. Meaningful only with a `flight`. */
  readonly fresh?: boolean | undefined;
  /** This call's retry override, handed to the `flight`. */
  readonly retry?: ClientRetry | undefined;
  /**
   * The decoded records envelope, after its records were adopted — only when the answer carried
   * `x-ultimate-records: 1` and belongs to the current principal. What a caller reads to know the
   * ORDER of `records[type]`, which the store (keyed, unordered) cannot give it back.
   */
  readonly onEnvelope?: ((envelope: RecordEnvelope) => void) | undefined;
  /** Sees every response before its body is read — a header check may throw its own refusal. */
  readonly onResponse?: ((response: Response) => void | Promise<void>) | undefined;
  /** A non-2xx answer as the caller's own error; `undefined` falls back to the shared decode. */
  readonly decodeError?: ((status: number, text: string) => UltimateError | undefined) | undefined;
  /** Default `globalThis.fetch`, read at call time — never captured at module scope. */
  readonly fetchImpl?: FetchLike | undefined;
}

/** One dispatch's answer: immutable TEXT, so a deduped read's joiners each parse their own. */
export interface Answer {
  readonly text: string;
  readonly enveloped: boolean;
}

/** Called, never captured: a browser's `fetch` throws `Illegal invocation` when detached. */
const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export async function dispatch(
  req: TransportRequest,
  read: boolean,
  issued: number,
  flightSignal: AbortSignal | undefined,
): Promise<Answer> {
  // A read gets its own controller so the fence can abort it; a write never does, and only its
  // caller's own signal reaches it (a flight never hands a write one).
  const fence = read ? abortable([req.signal, flightSignal]) : undefined;
  const signal = fence === undefined ? req.signal : fence.signal;
  try {
    const response = await onTheWire(req, read, () =>
      (req.fetchImpl ?? browserFetch)(req.url, initOf(req, signal)),
    );
    await req.onResponse?.(response);
    // Read as TEXT once: a body is a single-use stream, and the failure path wants it too.
    const text = response.status === 204 ? '' : await onTheWire(req, read, () => response.text());
    if (!response.ok) {
      throw (
        req.decodeError?.(response.status, text) ?? problemError(response.status, text, req.url)
      );
    }
    return { text, enveloped: response.headers.get(RECORDS_HEADER) === '1' };
  } catch (error) {
    const current = pageClient().scope.epoch;
    if (read && current !== issued) throw scopeChanged(req.url, issued, current);
    throw error;
  } finally {
    fence?.release();
  }
}

/**
 * The network's half of a dispatch, and only that half. `fetch` — and a body read cut mid-stream —
 * rejects with a bare `TypeError` when no response arrived; that is `failure: 'network'`. A caller's
 * `onResponse` or `decodeError` throwing a `TypeError` is a bug in the caller, and classifying it
 * as the network made it retryable, so a flight re-sent the request for it. An abort is a decision
 * and passes through untouched.
 */
async function onTheWire<T>(
  req: TransportRequest,
  read: boolean,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw transportFailed(
      'network',
      `${req.method} ${req.url} produced no response — the network refused or dropped it`,
      read || req.idempotencyKey !== undefined ? 'retryable' : undefined,
      { url: req.url, method: req.method },
      error,
    );
  }
}

function initOf(req: TransportRequest, signal: AbortSignal | undefined): RequestInit {
  const raw = req.rawBody !== undefined;
  const headers: Record<string, string> = raw ? {} : { accept: 'application/json' };
  if (req.body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (req.idempotencyKey !== undefined) headers[IDEMPOTENCY_HEADER] = req.idempotencyKey;
  const body = raw ? req.rawBody : req.body === undefined ? undefined : JSON.stringify(req.body);
  // Server-side only: the slot is filled by `runWithContext`/`startSpan` (`outbound-headers.ts`),
  // and a signed raw upload never carries it — an extra header can break the signature.
  const outbound = raw ? undefined : outboundSlot().outboundHeaders?.();
  return {
    method: req.method,
    credentials: 'same-origin',
    headers: { ...headers, ...outbound, ...req.headers },
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/**
 * A read's controller: aborted by `rescope()`, by the caller's signal or by the flight's. Every
 * listener comes off in `release`, so a long-lived caller signal does not collect one per request.
 */
function abortable(sources: readonly (AbortSignal | undefined)[]): {
  readonly signal: AbortSignal;
  release(): void;
} {
  const controller = new AbortController();
  const detach: (() => void)[] = [onRescope(() => controller.abort())];
  for (const source of sources) {
    if (source === undefined) continue;
    if (source.aborted) controller.abort(source.reason);
    const forward = (): void => controller.abort(source.reason);
    source.addEventListener('abort', forward, { once: true });
    detach.push(() => source.removeEventListener('abort', forward));
  }
  return {
    signal: controller.signal,
    release: (): void => {
      for (const off of detach) off();
    },
  };
}
