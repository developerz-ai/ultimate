// Single responsibility: the one keyset-cursor codec. A page position is signed here and
// verified here, so the repo, the read primitive and the admin cannot drift into three formats
// with three trust levels.
//
// Signed, not encrypted: the client already holds the rows the cursor points at. What the
// signature buys is that a client cannot *invent* a position, and what `scope` buys is that a
// cursor from one read cannot be replayed against another — either is `X_CURSOR_INVALID`, never
// a silently wrong page. It is tamper-evidence, not authorization: policy still runs per page.

import { UltimateError } from './errors';

export interface CursorPayload {
  /** What this cursor belongs to: one read plus its arguments. A cursor is not portable. */
  readonly scope: string;
  /** The ordering tuple of the last row on the page, in `orderBy` order. */
  readonly key: readonly unknown[];
  /** Primary key of that row — the tiebreak that makes the sort order total. */
  readonly id: string;
}

export class CursorInvalidError extends UltimateError {
  override readonly name = 'CursorInvalidError';

  constructor(reason: string) {
    super({
      code: 'X_CURSOR_INVALID',
      cause: `cursor rejected: ${reason}`,
      fix: 'drop the cursor and request the first page again (after: null)',
      meta: { reason },
    });
  }
}

/**
 * Dev default so `x dev` pages without configuration. Production sets `ULTIMATE_CURSOR_SECRET`
 * — a fixed literal rather than a per-process random one on purpose: a random secret would make
 * a cursor issued by one instance fail on the next, and that failure only shows up under scale.
 */
const DEV_SECRET = 'ultimate-dev-cursor-secret';

let secret = Bun.env['ULTIMATE_CURSOR_SECRET'] ?? DEV_SECRET;

/** Set once at boot from the app secret. Rotating it invalidates every open cursor. */
export function configureCursorSigning(next: string): void {
  secret = next;
}

/** True while cursors are signed with the shipped dev key — `x doctor` reports it. */
export function usesDevCursorSecret(): boolean {
  return secret === DEV_SECRET;
}

/** `base64url(payload).signature`. Opaque by contract: callers must never parse it. */
export function encodeCursor(payload: CursorPayload): string {
  const body = encodeBody(JSON.stringify([payload.scope, payload.id, payload.key]));
  return `${body}.${sign(body)}`;
}

/**
 * The only way back. `scope` is required rather than optional because an optional check is one
 * a call site can forget, and a forgotten check is a cursor from another query paging this one.
 */
export function decodeCursor(cursor: string, scope: string): CursorPayload {
  const dot = cursor.lastIndexOf('.');
  if (dot <= 0) throw new CursorInvalidError('not a signed cursor');
  const body = cursor.slice(0, dot);
  if (!sameSignature(sign(body), cursor.slice(dot + 1))) {
    throw new CursorInvalidError('signature does not match — tampered with, or the secret rotated');
  }

  const parsed = parseBody(body);
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new CursorInvalidError('not a cursor');
  const [encodedScope, id, key] = parsed as readonly unknown[];
  if (typeof encodedScope !== 'string' || typeof id !== 'string' || !Array.isArray(key)) {
    throw new CursorInvalidError('not a cursor');
  }
  if (encodedScope !== scope) {
    throw new CursorInvalidError('it belongs to a different query, filter or sort order');
  }
  return { scope: encodedScope, key, id };
}

/** Truncated HMAC-SHA256. 128 bits is far past forging a page position. */
function sign(body: string): string {
  return new Bun.CryptoHasher('sha256', secret).update(body).digest('hex').slice(0, 32);
}

/** Constant time: the comparison must not leak how much of a forged signature was right. */
function sameSignature(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

// A cursor travels in a query string and carries row values, so the encoding has to survive
// both: base64url (no `+`, `/` or `=` for a caller to re-encode) over UTF-8 bytes — `btoa`
// alone throws above code point 0xFF, and one accented title would break pagination.
function encodeBody(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function parseBody(body: string): unknown {
  const padded = body.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw new CursorInvalidError('payload is not readable');
  }
}
