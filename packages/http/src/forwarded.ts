// Who the caller really is when a proxy is in front of us. `trustProxy` documented reading
// `x-forwarded-for` and nothing in the framework ever read it: every anonymous request behind an
// ingress keyed the rate limiter to the proxy's address — ONE bucket for the whole internet — and
// `ctx.https` was false on a TLS-terminated hop, so HSTS was never emitted in the shape the
// framework's own chart ships.

import type { HttpConfig } from './config';

export const FORWARDED_FOR = 'x-forwarded-for';
export const FORWARDED_PROTO = 'x-forwarded-proto';
/** Envoy's XFCC. Read here rather than in a second module, so there is ONE trust rule. */
export const FORWARDED_CLIENT_CERT = 'x-forwarded-client-cert';

/** How a header's comma-separated list is cut. XFCC needs quote awareness; the others do not. */
export type ForwardedSplit = (value: string, separator: string) => readonly string[];

const plainSplit: ForwardedSplit = (value, separator) =>
  value
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

/**
 * The element a TRUSTED proxy wrote, counting from the right. Every proxy appends its own peer,
 * so with `hops` trusted proxies in front of this process the caller is `list.length - hops` —
 * never `list[0]`, which is whatever the client typed. Fewer entries than the deployment declared
 * means the chain is not the one configured, so there is no trusted entry at all and this answers
 * `undefined`: falling back to the leftmost value is exactly the spoof the count exists to stop.
 *
 * Every proxy-supplied header goes through this one function — address, protocol and peer
 * certificate alike. A second trust rule is a second thing to get wrong, and the one that reads
 * a certificate would be the one that authenticates.
 */
export const forwardedElement = (
  header: string | null,
  hops: number,
  split: ForwardedSplit = plainSplit,
): string | undefined => {
  if (header === null || hops < 1) return undefined;
  const list = split(header, ',');
  const index = list.length - hops;
  if (index < 0 || index >= list.length) return undefined;
  return list[index];
};

/** The plain-list form: `x-forwarded-for`, `x-forwarded-proto`. */
export const forwardedValue = (header: string | null, hops: number): string | undefined =>
  forwardedElement(header, hops);

/**
 * `1.2.3.4:5678` and `[::1]:443` are both legal in an `x-forwarded-for` entry; the port is the
 * proxy's bookkeeping and would make every connection its own rate-limit bucket.
 */
const withoutPort = (address: string): string => {
  if (address.startsWith('[')) {
    const close = address.indexOf(']');
    return close === -1 ? address : address.slice(1, close);
  }
  // A bare IPv6 has several colons and no port; only a single colon is host:port.
  const colon = address.indexOf(':');
  if (colon === -1 || address.indexOf(':', colon + 1) !== -1) return address;
  return address.slice(0, colon);
};

export interface ForwardedInput {
  readonly headers: Headers;
  readonly config: HttpConfig;
  /** What the socket says. Always the fallback, and the only answer when nothing is trusted. */
  readonly socketAddress: string | null;
  /** The scheme of the URL this process was reached on. */
  readonly urlProtocol: string;
}

/** The address the rate limiter keys on and the audit trail records. */
export const clientAddress = (input: ForwardedInput): string | null => {
  const forwarded = forwardedValue(input.headers.get(FORWARDED_FOR), input.config.trustedProxyHops);
  if (forwarded === undefined) return input.socketAddress;
  const address = withoutPort(forwarded);
  return address.length > 0 ? address : input.socketAddress;
};

/**
 * Whether the CLIENT's leg of the connection was TLS. Read at the same hop index as the address,
 * because `x-forwarded-proto` is as forgeable as `x-forwarded-for` — and this one decides whether
 * a two-year `includeSubDomains` HSTS policy goes out.
 */
export const clientUsedHttps = (input: ForwardedInput): boolean => {
  const forwarded = forwardedValue(
    input.headers.get(FORWARDED_PROTO),
    input.config.trustedProxyHops,
  );
  if (forwarded === undefined) return input.urlProtocol === 'https:';
  return forwarded.toLowerCase() === 'https';
};
