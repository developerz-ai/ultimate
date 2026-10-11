// The URL a SHARED document (`static`, `isr`) is rendered at and kept under: the request's own, at
// the one spelling of the address the router matched. The router answers `/about/`, `//about` and
// `/%61bout` with one page; a document one visitor's spelling rendered and the next visitor is
// answered must not carry the first one's spelling in its `canonical`, nor be kept once per spelling.

import type { RequestContext } from '@ultimat3/http';
import { requestAddress } from '@ultimat3/http';

/** `url` with its pathname respelled (`requestAddress`); unchanged before a route matched. */
export function addressedUrl(url: URL, ctx: RequestContext): URL {
  const address = requestAddress(ctx);
  if (address === undefined || address.pathname === url.pathname) return url;
  const at = new URL(url);
  at.pathname = address.pathname;
  return at;
}
