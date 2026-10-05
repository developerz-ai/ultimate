/**
 * A browser request's failure, as the error it is: a non-2xx `problem+json` answer back into the
 * `UltimateError` the server threw, and a dispatch that produced no usable answer into
 * `X_CLIENT_TRANSPORT_FAILED`. The one decoder `clientTransport` owns, so every client surface
 * reads a failure off the wire the same way.
 */

import { FRAMEWORK_CODE, problemOf, retryForStatus } from './client-wire';
import { renderFixShellArg } from './error-render';
import type { ErrorRetry } from './error-retry';
import { UltimateError } from './errors';
import { isJsonObject } from './json-object';

/**
 * The longest remote title a client renders. Every framework title is well under it; a body that
 * sends more is not a title, and the overflow is cut rather than trusted.
 */
export const MAX_REMOTE_TITLE_LENGTH = 120;

/**
 * A problem document's `title`, as untrusted DISPLAY text: a non-blank string of at most
 * `MAX_REMOTE_TITLE_LENGTH` code points, control and format characters removed, or nothing. It reaches every renderer as text — `<ErrorState>` writes
 * it as a JSX text node, the terminal and `--json` as a string — and `UltimateError` makes it one
 * line, so no markup or second log line rides in on it. Used only where this realm registered no
 * title for the code (`UltimateErrorInit.remoteTitle`).
 */
export function remoteTitleOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters become a space and format characters (`\p{Cf}`: bidi overrides, isolates,
  // zero-width joiners) are dropped BEFORE the cap, so the cap is the length shown — escaping a
  // newline after cutting rendered two characters for one — and the cut is by CODE POINT, so it
  // never leaves half a surrogate pair.
  const shown = value
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\p{Cf}/gu, '')
    .replace(/ {2,}/g, ' ');
  const title = Array.from(shown.trim()).slice(0, MAX_REMOTE_TITLE_LENGTH).join('').trim();
  return title === '' ? undefined : title;
}

/** An absolute HTTP(S) link, or nothing: a server's `docs` is data and may be `javascript:`. */
const HTTP_URL = /^https?:\/\/[^\s]+$/;

/**
 * A non-2xx answer. A body naming a framework code IS the server's error, carried verbatim and
 * marked `origin: 'remote'` — the code may be one this bundle never registered. Anything else is
 * a proxy or a gateway answering instead of the app.
 */
export function problemError(
  status: number,
  text: string,
  url: string,
  retryAfterSeconds?: number,
): UltimateError {
  const body = problemOf(text);
  const code = body['code'];
  // The delay a 429 or 503 named, under core's ONE spelling (`statedDelayMs` reads it), so the
  // flight waits what the responder said whether or not this realm registered the code.
  const stated = retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
  if (typeof code !== 'string' || !FRAMEWORK_CODE.test(code)) {
    return transportFailed(
      'status',
      `${url} answered HTTP ${status} without a problem+json body naming a framework code`,
      retryForStatus('X_CLIENT_TRANSPORT_FAILED', status, retryAfterSeconds),
      { url, status, ...stated },
    );
  }
  const docs = [body['docs'], body['type']].find(
    (value): value is string => typeof value === 'string' && HTTP_URL.test(value),
  );
  return new UltimateError({
    code,
    cause: text1(body['cause']) ?? text1(body['detail']) ?? `${url} failed with HTTP ${status}`,
    fix: text1(body['fix']) ?? `x errors explain ${renderFixShellArg(code, '<code>')} --json`,
    remoteTitle: remoteTitleOf(body['title']),
    retry: retryForStatus(code, status, retryAfterSeconds),
    // The server's declared keys FIRST, so the ones this decoder owns win a collision.
    meta: { ...serverMeta(body['meta'], body['issues']), origin: 'remote', status, url, ...stated },
    ...(docs === undefined ? {} : { docs }),
  });
}

/**
 * WHICH way no usable answer came back, on `meta.failure` — what a caller branches on, since the
 * code is the same for all three: `network` (no response at all — the one an offline outbox
 * queues), `status` (a non-2xx no framework code explained) and `body` (a 2xx that is not JSON).
 */
export type TransportFailure = 'network' | 'status' | 'body';

/**
 * No usable answer: the network refused, the body stream broke, or a 2xx body was not JSON.
 * `retry` is the caller's to state — a read is always safe to send again, an unkeyed write never.
 */
export function transportFailed(
  failure: TransportFailure,
  cause: string,
  retry: ErrorRetry | undefined,
  meta: Readonly<Record<string, unknown>>,
  sourceError?: unknown,
): UltimateError {
  return new UltimateError({
    code: 'X_CLIENT_TRANSPORT_FAILED',
    cause,
    fix: 'check the network and the gateway in front of the app with x doctor --json, then retry — a write with no idempotencyKey may already have landed',
    ...(retry === undefined ? {} : { retry }),
    meta: { ...meta, failure },
    ...(sourceError === undefined ? {} : { sourceError }),
  });
}

/**
 * The document's `meta`, copied own key by own key: `JSON.parse` mints `__proto__` as a real own
 * key, and assigned onto a plain object it would replace the prototype. `issues` rides along
 * unparsed for the caller whose schema can read it.
 */
function serverMeta(meta: unknown, issues: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isJsonObject(meta)) {
    for (const [key, member] of Object.entries(meta)) {
      if (key === '__proto__') continue;
      Object.defineProperty(out, key, { value: member, writable: true, enumerable: true });
    }
  }
  if (Array.isArray(issues)) out['issues'] = issues;
  return out;
}

function text1(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
