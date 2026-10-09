/**
 * The ONE browser HTTP function. Every client surface — `rpc()`, `queryClient()`, a signed upload,
 * the store's refetch — sends through here, so credentials, headers, the error decode, the records
 * envelope and the principal fence are decided once. A GET is a read: abortable on `rescope()`,
 * deduped when a `ClientFlight` is supplied. Anything else is a write: never deduped, never
 * aborted by the fence, and its records never adopted across one.
 *
 * `clientFlight` is NOT imported here at value level — a caller passes one, and only then
 * does its graph enter the bundle. Neither is `traceHeaders()`: the trace and budget headers come
 * from an outbound slot that `runWithContext`/`startSpan` fill SERVER-side (`outbound-headers.ts`),
 * so a browser, which never has either, carries zero bytes of telemetry, context or logger.
 *
 * Measured `bun build --target=browser --minify` through the barrel, As of 2026-09-22 (before →
 * after the outbound slot): `rpc` 23,164 → 18,119 B; `queryClient` 24,100 → 22,897 B (the rest is
 * `@ultimat3/query`'s anchored `registry.ts`); `clientTransport` 13,571 B; `pageClient` 8,139 B;
 * `UltimateError` 7,679 B. ~7.6 kB of every barrel import is the error-code registry that the
 * anchored `schema-error-codes.ts` registers into — `pageClient` straight from its module is 332 B.
 */

import type { Answer, TransportRequest } from './client-dispatch';
import { dispatch } from './client-dispatch';
import { transportFailed } from './client-problem';
import { scopeChanged } from './client-scope-error';
import { notifyClientWrite } from './client-writes';
import type { RecordEnvelope } from './record-envelope';
import { decodeRecordEnvelope } from './record-envelope';
import { pageClient, recordSink } from './record-sink';
import { reviveWireDates } from './wire-dates';

const ONCE = { attempts: 1 } as const;

/** `responseType: 'text'`: the 2xx body as a string, never decoded. */
export function clientTransport(
  req: TransportRequest & { readonly responseType: 'text' },
): Promise<string>;
export function clientTransport<T = unknown>(req: TransportRequest): Promise<T>;
export async function clientTransport<T = unknown>(req: TransportRequest): Promise<T> {
  const read = req.method === 'GET';
  const issued = pageClient().scope.epoch;
  const flight = req.flight;
  let answer: Answer;
  try {
    answer =
      flight === undefined
        ? await dispatch(req, read, issued, undefined)
        : await flight.run({
            // A mutation never joins another mutation, idempotency key or not: the key is for the
            // server's replay, and sharing one dispatch would hide the second intent from it.
            key: read
              ? flight.keyFor(req.url, { signal: req.signal, fresh: req.fresh })
              : undefined,
            abortable: read,
            // The caller's own signal ends a WAIT between attempts; each attempt already reads it.
            signal: req.signal,
            // A stream is read once, so a second attempt re-sends a body that is already spent —
            // and fails as the network would, until the attempts run out. One attempt, always.
            retry: req.rawBody instanceof ReadableStream ? ONCE : req.retry,
            run: (signal) => dispatch(req, read, issued, signal),
            // `dispatch` makes every wire failure `X_CLIENT_TRANSPORT_FAILED`; a bare throw that
            // reaches the flight is a caller hook's, never the network's.
            classified: true,
          });
  } finally {
    // After it settles, landed or not — a write that failed on the wire may still have committed,
    // and announcing it before it settled left a window for a prefetch to cache the old state.
    if (!read) notifyClientWrite(req.url);
  }
  const current = pageClient().scope.epoch;
  // A read that raced the abort still belongs to the previous principal.
  if (read && current !== issued) throw scopeChanged(req.url, issued, current);
  // Read as text: nothing to decode, and no records envelope — that is a JSON answer's. Before the
  // `rawBody` return, so the overload's `Promise<string>` holds for a raw upload read as text too.
  if (req.responseType === 'text') return answer.text as T;
  if (req.rawBody !== undefined) return undefined as T;
  const envelope = unwrap(answer, req.url, read);
  // A write that crossed a rescope HAS landed, so its caller is told — but its rows are the
  // previous principal's, and the new scope's store never sees them.
  if (current === issued) {
    adopt(envelope);
    if (answer.enveloped) req.onEnvelope?.(envelope);
  }
  return envelope.data as T;
}

function unwrap(answer: Answer, url: string, read: boolean): RecordEnvelope {
  let body: unknown;
  try {
    body = answer.text === '' ? undefined : (JSON.parse(answer.text) as unknown);
  } catch (error) {
    throw transportFailed(
      'body',
      `${url} answered 2xx with a body that is not JSON — a proxy answered instead of the app`,
      read ? 'retryable' : undefined,
      { url },
      error,
    );
  }
  const envelope = answer.enveloped ? decodeRecordEnvelope(body) : { data: body };
  // In place, on this caller's own parse: a deduped read's joiners each parsed their own copy.
  return { ...envelope, data: reviveWireDates(envelope.data, answer.dates) };
}

/** Adopt, then remove: a key in both is gone, never resurrected by the same answer. */
function adopt(envelope: RecordEnvelope): void {
  const sink = recordSink();
  if (sink === undefined) return;
  for (const [type, rows] of Object.entries(envelope.records ?? {})) sink.adopt(type, rows);
  for (const [type, keys] of Object.entries(envelope.removed ?? {})) sink.remove(type, keys);
}
