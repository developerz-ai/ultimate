// Who the MESH says is calling. TLS termination is the mesh's job (axiom 7) so the framework's
// entire contribution is reading a header it has been TOLD to trust (`trustClientCertHeader`):
// Envoy's `x-forwarded-client-cert`, at the hop index `x-forwarded-for` is read at. Untrusted,
// this header is worse than nothing — it authenticates — so an untrusted read answers `null`.

import {
  FORWARDED_CLIENT_CERT,
  type ForwardedInput,
  type ForwardedSplit,
  forwardedElement,
} from './forwarded';

/**
 * The peer's certificate facts, declared structurally rather than imported: `@ultimat3/auth` owns
 * `ServiceIdentity` and is this tier, so it can never be imported here — the same reason
 * `AuthzDecision` and `OverlayNotice` are declared in this package. An app maps this onto a
 * `ServiceIdentity` inside its `configureAuthenticator()`, which is the ONE funnel:
 * `verifyWorkloadToken(...)` -> `actorFromService(identity)` -> `ctx.actor`. Never a second
 * authz system that reads a certificate and decides on its own.
 */
export interface PeerIdentity {
  /**
   * The SPIFFE ID if the peer presented one, else the subject DN, else the first URI SAN. What an
   * app keys a service on — and always a value a trusted proxy wrote, never the caller.
   */
  readonly id: string;
  /** `spiffe://…` from the URI SANs, when there is one. */
  readonly spiffeId: string | null;
  /** The certificate subject DN, e.g. `CN=checkout,OU=payments`. */
  readonly subject: string | null;
  readonly uriSans: readonly string[];
  readonly dnsSans: readonly string[];
  /** The proxy that terminated the TLS connection, as it named itself. */
  readonly by: string | null;
}

/** True when the `"` at `at` is escaped: an odd run of backslashes sits directly before it. */
const escapedQuote = (value: string, at: number): boolean => {
  let run = at - 1;
  while (run >= 0 && value[run] === '\\') run -= 1;
  return (at - 1 - run) % 2 === 1;
};

/** Nothing but whitespace from `from` up to the pair's end: a `;`, or the element's own end. */
const endsPair = (value: string, from: number, end: number): boolean => {
  for (let at = from; at < end; at += 1) {
    const char = value[at];
    if (char === ';') return true;
    if (char !== ' ' && char !== '\t') return false;
  }
  return true;
};

/**
 * The last `hops` elements of the list — the ones the trusted proxies appended — and nothing
 * else. Read from the RIGHT, because the client writes everything before them: a left-to-right
 * reader carries the client's quote state into the proxy's text, so one odd `"` turned the
 * proxy's own `\"` into a closing quote, swallowed the trusted comma and handed the hop index to
 * the client's `URI=`. From the right, where an element starts depends only on what is in it.
 *
 * An element is isolated only when it is well formed, since anything else can be re-read by what
 * precedes it: a quoted value is `="…"` whole — the opening quote directly after `=`, the closing
 * one ending its pair — and a `"` anywhere else is no element. That, or a quote still open at the
 * start of the header, answers `[]`: no element is trustworthy, so `peerIdentity` is `null`.
 * Empty elements are not hops, as in every other forwarded list.
 */
const trustedSuffix =
  (hops: number): ForwardedSplit =>
  (value, separator) => {
    const found: string[] = [];
    let end = value.length;
    let quoted = false;
    const take = (from: number): void => {
      const element = value.slice(from, end).trim();
      if (element.length > 0) found.push(element);
      end = from - 1;
    };
    for (let at = value.length - 1; at >= 0 && found.length < hops; at -= 1) {
      const char = value[at];
      if (char === '"') {
        const escaped = escapedQuote(value, at);
        if (quoted) {
          if (escaped) continue;
          if (value[at - 1] !== '=') return [];
          quoted = false;
        } else {
          if (escaped || !endsPair(value, at + 1, end)) return [];
          quoted = true;
        }
      } else if (char === separator && !quoted) {
        take(at + 1);
      }
    }
    if (quoted) return [];
    if (found.length < hops) take(0);
    return found.reverse();
  };

/**
 * Splits ONE isolated element on a separator outside double quotes, keeping the quotes and escapes
 * EXACTLY as written. Raw on purpose: an element split that also stripped quotes left `pairsOf`
 * splitting `O=Acme; Inc` a second time, unquoted. Unescaping happens once, per value, in
 * `unquote`. Left to right is safe here and only here: every character is the proxy's, and
 * `trustedSuffix` has already refused a quote this reading would pair differently.
 */
const splitRaw = (value: string, separator: string): readonly string[] => {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\' && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === separator && !quoted) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted) return [];
  out.push(current.trim());
  return out.filter((entry) => entry.length > 0);
};

/** `"CN=checkout\""` → `CN=checkout"`. An unquoted value is taken as written. */
const unquote = (value: string): string => {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, '$1');
};

/** `Key=Value` pairs, keys lowercased. `URI` and `DNS` may repeat, so values collect. */
const pairsOf = (element: string): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, string[]>();
  for (const pair of splitRaw(element, ';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = unquote(pair.slice(eq + 1).trim());
    if (value.length === 0) continue;
    const existing = out.get(key);
    if (existing === undefined) out.set(key, [value]);
    else existing.push(value);
  }
  return out;
};

/**
 * The peer identity a TRUSTED proxy asserted, or `null`. `null` is the answer for a deployment
 * that did not declare `trustClientCertHeader`, an untrusted one, a missing header and a chain
 * shorter than `trustedProxyHops` alike: a certificate
 * identity read from a hop nobody vouched for is a confident name for an attacker's claim.
 */
export const peerIdentity = (input: ForwardedInput): PeerIdentity | null => {
  // Its own declaration, never implied by `trustProxy`: that one says the proxy APPENDS to
  // `x-forwarded-for`, and plenty of ingresses that do pass a client-sent certificate header
  // straight through — where the caller would be naming its own identity.
  if (!input.config.trustClientCertHeader) return null;
  const element = forwardedElement(
    input.headers.get(FORWARDED_CLIENT_CERT),
    input.config.trustedProxyHops,
    trustedSuffix(input.config.trustedProxyHops),
  );
  if (element === undefined) return null;
  const pairs = pairsOf(element);
  const uriSans = pairs.get('uri') ?? [];
  const dnsSans = pairs.get('dns') ?? [];
  const subject = pairs.get('subject')?.[0] ?? null;
  const spiffeId = uriSans.find((uri) => uri.startsWith('spiffe://')) ?? null;
  const id = spiffeId ?? subject ?? uriSans[0] ?? null;
  if (id === null) return null;
  return {
    id,
    spiffeId,
    subject,
    uriSans,
    dnsSans,
    by: pairs.get('by')?.[0] ?? null,
  };
};
