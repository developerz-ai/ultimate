// Single responsibility: a declared read's validator. The ETag is a strong hash of the bytes the
// policy already judged, keyed to the actor who was judged, and the 304 is `@ultimat3/http`'s
// `notModified` — the one `If-None-Match` reader, so this file never compares a header itself.

import { notModified, PRIVATE_REVALIDATE, type UltimateRequest } from '@ultimat3/http';
import { readAuthority } from './cache';

/**
 * `"<sha-256, base64url>"` over the actor's authority and the body. The authority is in the hash so
 * one actor's validator never confirms that another's rows are unchanged: two callers seeing the
 * same bytes still hold two validators.
 */
function etagOf(authority: string, body: ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(authority);
  hasher.update('\0');
  hasher.update(body);
  return `"${hasher.digest('base64url')}"`;
}

/**
 * The answer with its validator, or the bodiless 304 when the caller already holds it. Called with
 * the response `runQuery` produced, so the policy and the rate limit have already run: a 304 is
 * still a read of that person's rows. Only a 200 carries one — a refusal is never revalidated.
 */
export async function withValidator(
  request: UltimateRequest,
  response: Response,
): Promise<Response> {
  if (response.status !== 200) return response;
  const body = await response.arrayBuffer();
  const etag = etagOf(readAuthority(request.ctx.actor, 'actor'), body);
  const headers = new Headers(response.headers);
  headers.set('cache-control', PRIVATE_REVALIDATE);
  headers.set('etag', etag);
  const unchanged = notModified(request, etag, headers);
  if (unchanged !== undefined) {
    // A 304 carries no body, and no header describing one.
    unchanged.headers.delete('content-length');
    unchanged.headers.delete('content-type');
    return unchanged;
  }
  return new Response(body, { status: 200, headers });
}
