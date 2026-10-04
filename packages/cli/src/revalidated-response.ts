// The one answer for a public file whose URL carries NO content hash: cacheable, revalidated on
// every use, and a 304 when the bytes have not moved. `immutable` belongs to a URL that IS its
// content (islands, styles, `asset()` files) and to nothing else — a file served immutable under a
// name that outlives its bytes is a file no client refreshes for a year.

import type { UltimateRequest } from '@ultimat3/http';
import { contentHash } from '@ultimat3/render/server';
import { etagMatches } from './runtime-storage';

/**
 * The document's own posture (`@ultimat3/render`'s `render-static.ts`), for the same reason: the
 * URL says nothing about the bytes, so a cache may keep them and must ask before reusing them.
 * Written as a header rather than a `CacheHint`, which has no `must-revalidate`.
 */
export const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';

/**
 * A strong validator from the bytes — `@ultimat3/render`'s `contentHash`, the function a document's
 * ETag is, taken here over bytes because an icon is not a string. Revalidating costs a request and no body.
 */
export function revalidatedResponse(
  request: UltimateRequest,
  body: string | Uint8Array,
  contentType: string,
): Response {
  // Copied, not passed through: a `Uint8Array<ArrayBufferLike>` may be backed by a
  // `SharedArrayBuffer`, which `Response` does not accept — `runtime-assets.ts`'s rule, verbatim.
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
  const etag = `"${contentHash(bytes)}"`;
  const headers = {
    'content-type': contentType,
    'cache-control': REVALIDATE_CACHE_CONTROL,
    etag,
  };
  if (etagMatches(request.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bytes, { headers });
}
