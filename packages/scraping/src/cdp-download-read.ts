// One paused document response's body, read under a BYTE CAP — or not read at all. A scraped page
// decides what it serves, so a multi-gigabyte body must never be buffered whole in the worker.
//
// Declared over the cap: left to Chrome, untouched. Undeclared and not an attachment: left too,
// since cutting it would break what the page shows. Otherwise `Fetch.takeResponseBodyAsStream` and
// `IO.read` with a running count; under the cap the response is fulfilled with the very bytes
// read, past it the stream is closed and the response failed (measured on Chrome 157, 2026-11-15).

import type { CdpSessionLike } from './cdp-port';

/** The default cap on one captured file: 25 MiB, a large export and far from a worker's heap. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** One `IO.read`'s size. Small enough that overshooting the cap costs at most this much. */
const READ_CHUNK = 1024 * 1024;

export interface PausedResponse {
  readonly requestId: string;
  readonly status: number;
  /** The wire's own `[{ name, value }]`, passed back untouched when the response is fulfilled. */
  readonly headers: readonly unknown[];
  readonly declaredLength: number | undefined;
  readonly attachment: boolean;
}

/** What the read did: whether it released the response itself. */
export interface CappedRead {
  readonly released: boolean;
}

const bytesOf = (data: string, base64: boolean): Uint8Array =>
  base64
    ? Uint8Array.from(atob(data), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(data);

/** Base64 of `bytes`, chunked so a large body never overflows `String.fromCharCode`'s arguments. */
const base64Of = (bytes: Uint8Array): string => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32_768));
  }
  return btoa(binary);
};

const joined = (parts: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Read `paused`'s body if it may be read, never past `maxBytes`. Never throws: it runs inside a
 * protocol event handler. Once the stream is taken the response cannot be continued as it was, so
 * every path after that point releases it — fulfilled with the body, or failed.
 */
export async function readCapped(
  session: CdpSessionLike,
  paused: PausedResponse,
  maxBytes: number,
  keep: (body: Uint8Array) => void,
): Promise<CappedRead> {
  const { requestId } = paused;
  if (paused.declaredLength !== undefined && paused.declaredLength > maxBytes) {
    return { released: false };
  }
  if (paused.declaredLength === undefined && !paused.attachment) return { released: false };
  let handle: unknown;
  try {
    handle = record(await session.send('Fetch.takeResponseBodyAsStream', { requestId }))['stream'];
  } catch {
    return { released: false };
  }
  if (typeof handle !== 'string') return { released: false };
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = record(await session.send('IO.read', { handle, size: READ_CHUNK }));
      const data = typeof chunk['data'] === 'string' ? chunk['data'] : '';
      const bytes = bytesOf(data, chunk['base64Encoded'] === true);
      total += bytes.length;
      if (total > maxBytes) {
        await session.send('IO.close', { handle }).catch(() => undefined);
        await session
          .send('Fetch.failRequest', { requestId, errorReason: 'Aborted' })
          .catch(() => undefined);
        return { released: true };
      }
      parts.push(bytes);
      if (chunk['eof'] === true) break;
    }
    await session.send('IO.close', { handle }).catch(() => undefined);
    const body = joined(parts, total);
    // Kept BEFORE the release: Chrome's `downloadWillBegin` may arrive ahead of the fulfil's own
    // reply, and a body stored after it would never be paired with its file.
    keep(body);
    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: paused.status,
      responseHeaders: paused.headers,
      body: base64Of(body),
    });
    return { released: true };
  } catch {
    // A stream that broke mid-read: the response is no longer continuable, so it is failed.
    await session
      .send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
      .catch(() => undefined);
    return { released: true };
  }
}
