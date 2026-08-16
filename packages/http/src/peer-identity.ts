// Who the MESH says is calling. TLS termination is the mesh's job (axiom 7) so the framework's
// entire contribution is reading a header it has been TOLD to trust: Envoy's
// `x-forwarded-client-cert`, at the same hop index `x-forwarded-for` is read at. Untrusted, this
// header is worse than nothing — it authenticates — so an untrusted read answers `null` and
// there is no second proxy-trust path to get it wrong in.

import { FORWARDED_CLIENT_CERT, type ForwardedInput, forwardedElement } from './forwarded';

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

/** Splits on a separator that is not inside a double-quoted value. `Subject="CN=a,OU=b"`. */
const splitUnquoted = (value: string, separator: string): readonly string[] => {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === separator && !quoted) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out.filter((entry) => entry.length > 0);
};

/** `Key=Value` pairs, keys lowercased. `URI` and `DNS` may repeat, so values collect. */
const pairsOf = (element: string): ReadonlyMap<string, readonly string[]> => {
  const out = new Map<string, string[]>();
  for (const pair of splitUnquoted(element, ';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (value.length === 0) continue;
    const existing = out.get(key);
    if (existing === undefined) out.set(key, [value]);
    else existing.push(value);
  }
  return out;
};

/**
 * The peer identity a TRUSTED proxy asserted, or `null`. `null` is the answer for an untrusted
 * deployment, a missing header and a chain shorter than `trustedProxyHops` alike: a certificate
 * identity read from a hop nobody vouched for is a confident name for an attacker's claim.
 */
export const peerIdentity = (input: ForwardedInput): PeerIdentity | null => {
  const element = forwardedElement(
    input.headers.get(FORWARDED_CLIENT_CERT),
    input.config.trustedProxyHops,
    splitUnquoted,
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
