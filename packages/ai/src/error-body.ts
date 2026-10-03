// Single responsibility: what a provider's own failure body says, and the credential that must
// never survive into it.
//
// Shared by both transports rather than copied: every endpoint this package speaks to reports a
// failure in the same `{ error: { message } }` envelope, and every one of them carries a key in a
// header a proxy can echo into its own 4xx body. Two copies of either rule is two behaviours to
// keep in step — and the scrub was on one provider only until 2026-08.

import { REDACTED } from '@ultimat3/core';

/** Enough of an error body to name the field that was wrong, not enough to fill a log. */
const DETAIL_LIMIT = 300;

/**
 * How much of a failure body is READ. Larger than what is shown, because the message sits inside a
 * JSON envelope that has to parse; bounded, because a provider streaming an endless 5xx body held
 * the call and its memory for as long as it kept sending.
 */
const READ_LIMIT = 4 * 1024;

/**
 * The provider's own message, when it sent one — it names the offending field, we name the fix.
 * Falls back to the raw text because a proxy or a gateway timeout page is not JSON and is still
 * the best evidence there is. One reader for every transport, the embedder included.
 */
export async function detailOf(response: Response): Promise<string> {
  const body = await boundedText(response.body);
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') return message.slice(0, DETAIL_LIMIT);
      }
    }
  } catch {
    // Not JSON — a proxy or a gateway timeout page, or a body cut at the read limit.
  }
  return body === '' ? response.statusText : body.slice(0, DETAIL_LIMIT);
}

/** The start of a body, never more than `READ_LIMIT` bytes of it; the rest is cancelled. */
async function boundedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (body === null) return '';
  const reader = body.getReader();
  const kept: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      kept.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body that fails mid-read still has whatever arrived; the status is the error's substance.
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of kept) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Every occurrence of the credential replaced with `[redacted]`. Cheap, and the one leak path:
 * a proxy that echoes the request headers into its own 400 body puts the key in an error, and an
 * error reaches a log index, a span and an HTTP problem document.
 */
export function withoutKey(detail: string, apiKey: string): string {
  if (apiKey === '') return detail;
  return detail.split(apiKey).join(REDACTED);
}
