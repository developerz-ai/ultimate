// Single responsibility: the one rule for "did this request carrying an AMBIENT credential come
// from this app?" — `@ultimat3/http`'s CSRF check asks it of an unsafe write, and
// `@ultimat3/realtime`'s sync node of a websocket upgrade. One rule, so a sibling origin cannot be
// let in by one surface and refused by the other.

/** The complete `Sec-Fetch-Site` vocabulary. Anything else was written by a non-browser. */
const KNOWN_SITES = new Set(['same-origin', 'same-site', 'cross-site', 'none']);

export interface OriginEvidence {
  /** The origins this app is reached on. More than one when the scheme is not knowable here. */
  readonly selfOrigins: readonly string[];
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  /** An EXACT allowance for a sibling origin — never a wildcard, never a suffix match. */
  readonly listed: (origin: string) => boolean;
  /** Where the operator adds an origin, named in the refusal: `http.cors.origins`, `SYNC_ORIGINS`. */
  readonly listName: string;
}

export type OriginVerdict =
  | { readonly ok: true }
  /** Why it was refused, in terms the caller can act on. Never echoes a header verbatim. */
  | { readonly ok: false; readonly reason: string };

/**
 * `sec-fetch-site` first because it is the browser's own answer and cannot be set by script;
 * `Origin` second, so an app that lists a sibling origin keeps working. `same-site` is NOT proof:
 * a sibling subdomain is same-site, and a `SameSite=Lax` cookie rides its requests. A request with
 * neither header is refused — "we could not tell" is the case this exists for.
 */
export function proveSameOrigin(evidence: OriginEvidence): OriginVerdict {
  const site = evidence.secFetchSite;
  if (site === 'same-origin' || site === 'none') return { ok: true };
  const origin = evidence.origin;
  if (origin !== null && evidence.selfOrigins.includes(origin)) return { ok: true };
  if (origin !== null && evidence.listed(origin)) return { ok: true };
  // Only the four values a browser can send are quoted back. Anything else is a client that
  // wrote the header itself, and echoing what it wrote is how a rejected value reaches the log
  // store and the response body.
  if (site !== null) {
    const known = KNOWN_SITES.has(site) ? site : 'a value no browser sends';
    return { ok: false, reason: `the request reported sec-fetch-site: ${known}` };
  }
  return {
    ok: false,
    reason:
      origin === null
        ? 'the request carried neither sec-fetch-site nor origin, so it cannot be shown to be same-origin'
        : `the origin it declares is not this app and is not listed in ${evidence.listName}`,
  };
}
