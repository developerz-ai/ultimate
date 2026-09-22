/**
 * The ONE browser HTTP function. Every client surface — `rpc()`, `queryClient()`, a signed upload,
 * the store's refetch — sends through here, so credentials, headers, the error decode, the records
 * envelope and the principal fence are decided once. A GET is a read: abortable on `rescope()`,
 * deduped when a `ClientFlight` is supplied. Anything else is a write: never deduped, never
 * aborted by the fence, and its records never adopted across one.
 *
 * `createClientFlight` is NOT imported here at value level — a caller passes one, and only then
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
import type { RecordEnvelope } from './record-envelope';
import { decodeRecordEnvelope } from './record-envelope';
import { pageClient, recordSink } from './record-sink';

export async function clientTransport<T = unknown>(req: TransportRequest): Promise<T> {
  const read = req.method === 'GET';
  const issued = pageClient().scope.epoch;
  const flight = req.flight;
  const answer: Answer =
    flight === undefined
      ? await dispatch(req, read, issued, undefined)
      : await flight.run({
          // A mutation never joins another mutation, idempotency key or not: the key is for the
          // server's replay, and sharing one dispatch would hide the second intent from it.
          key: read ? flight.keyFor(req.url, { signal: req.signal, fresh: req.fresh }) : undefined,
          abortable: read,
          retry: req.retry,
          run: (signal) => dispatch(req, read, issued, signal),
        });
  const current = pageClient().scope.epoch;
  // A read that raced the abort still belongs to the previous principal.
  if (read && current !== issued) throw scopeChanged(req.url, issued, current);
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
  return answer.enveloped ? decodeRecordEnvelope(body) : { data: body };
}

/** Adopt, then remove: a key in both is gone, never resurrected by the same answer. */
function adopt(envelope: RecordEnvelope): void {
  const sink = recordSink();
  if (sink === undefined) return;
  for (const [type, rows] of Object.entries(envelope.records ?? {})) sink.adopt(type, rows);
  for (const [type, keys] of Object.entries(envelope.removed ?? {})) sink.remove(type, keys);
}
