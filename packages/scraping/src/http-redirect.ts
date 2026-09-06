// The redirect chain as a decision this leg makes hop by hop, rather than one `fetch` follows on
// its own. A followed redirect is a request to a URL nobody screened: `allowHosts`, robots and the
// rate limit are all asked about the url the caller wrote, and the answer comes back from wherever
// the site pointed. This file is the arithmetic — which status is a hop, where it goes, and what
// method carries — so `http.ts` re-applies the same three gates per hop and nothing else changes.

/**
 * The five statuses that carry a `Location` a client may follow. `300` is deliberately absent:
 * multiple choices has no single target, and picking one for the caller is guessing.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The hop ceiling, and a NAMED one so the refusal can quote it. Ten is the number every major
 * client settled on (curl's `--max-redirs`, the fetch spec's own counter) — high enough that no
 * honest CDN chain reaches it, low enough that a login bouncing to a page that bounces back costs
 * ten requests instead of a worker.
 */
export const MAX_REDIRECT_HOPS = 10;

/** What the next hop is asked with: a redirect can change the method and drop the body. */
export interface RedirectHop {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

/**
 * `303` means "look over there with a GET", and `301`/`302` after a POST mean the same thing in
 * every browser and every HTTP client shipped since — the spec permits the rewrite and universal
 * practice performs it. `307`/`308` exist precisely to say "re-send exactly what you sent", so
 * they keep both. Getting this wrong is not cosmetic: re-POSTing an order body at the URL a `303`
 * points to is a second order.
 */
const carriesBody = (status: number, method: string): boolean => {
  if (status === 307 || status === 308) return true;
  if (method === 'GET' || method === 'HEAD') return true;
  return false;
};

/**
 * The next hop, or `undefined` when this response IS the answer. A `Location` that will not parse
 * against the hop it came from is `undefined` too, and that is the fail-closed side: a URL this
 * package cannot resolve is a URL it cannot screen, so it is never requested — the 3xx becomes the
 * returned response and `X_SCRAPE_HTTP_FAILED` reports it with its own status.
 */
export function redirectHop(
  status: number,
  location: string | null,
  from: string,
  method: string,
  body: string | undefined,
): RedirectHop | undefined {
  if (!REDIRECT_STATUSES.has(status)) return undefined;
  if (location === null || location.trim() === '') return undefined;
  let resolved: string;
  try {
    resolved = new URL(location, from).toString();
  } catch {
    return undefined;
  }
  const keep = carriesBody(status, method);
  return {
    url: resolved,
    method: keep ? method : 'GET',
    body: keep ? body : undefined,
  };
}
