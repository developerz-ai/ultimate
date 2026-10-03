// The DNS half of `allowHosts`, for the two legs this package dials itself — the HTTP leg and the
// robots read. Core's `hostDecision` is synchronous and judges NAMES: a wildcard never admits an
// address literal inside the network, but `allowHosts: ['*']` still admits a hostname that
// resolves inward. So a name admitted by a wildcard alone is resolved here, every address
// classified by core's one classifier, and the connection PINNED to the approved address — the
// shape `@ultimat3/jobs`' `webhook-target.ts` takes for a webhook.

import type { HostRule } from '@ultimat3/core';
import { classifyAddress, hostMatches } from '@ultimat3/core';
import { hostResolvesInward } from './error-throws-session';

/** Every address a hostname answers. Injected in tests: the network is sealed in this repo. */
export type HostResolve = (hostname: string) => Promise<readonly string[]>;

/** `Bun.dns.lookup` — the runtime's own resolver, every family, every address. */
export const resolveHost: HostResolve = async (hostname) =>
  (await Bun.dns.lookup(hostname)).map((entry) => entry.address);

/** What the transport connects to: the URL to dial, and the name it proves when pinned. */
export interface DialTarget {
  readonly url: string;
  /** The original `host[:port]`, sent as the `Host` header of a pinned request. */
  readonly host?: string | undefined;
  /** For `https:` — the certificate is verified against the NAME, not the address. */
  readonly serverName?: string | undefined;
}

const isWildcard = (rule: HostRule): boolean => {
  const cleaned = rule.trim();
  return cleaned === '*' || cleaned.startsWith('*.');
};

/**
 * The connection for `url`, which `interceptVerdict` has ALREADY allowed. Unchanged when an exact
 * rule names the host — the app said that host, internal or not, in a line a reviewer can see —
 * or when the host is an address literal, which core's floor already judged. Otherwise resolved:
 * one address that is not public refuses the request (`X_SCRAPE_HOST_BLOCKED`), and the dial is
 * pinned to the first approved address, so a name that answers public here and private to the
 * socket (DNS rebinding) is never reached. A resolver failure propagates: nothing unscreened is
 * dialled, and the same name would not have resolved for `fetch` either.
 */
export async function dialTarget(
  url: string,
  allowHosts: readonly HostRule[],
  resolve: HostResolve,
): Promise<DialTarget> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url };
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (classifyAddress(hostname) !== undefined) return { url };
  if (allowHosts.some((rule) => !isWildcard(rule) && hostMatches(hostname, rule))) return { url };
  const addresses = await resolve(hostname);
  const inward = addresses.map((address) => classifyAddress(address) ?? 'unclassifiable');
  const refused =
    addresses.length === 0 ? 'unresolvable' : inward.find((kind) => kind !== 'public');
  if (refused !== undefined) throw hostResolvesInward(url, hostname, refused);
  const pinned = addresses[0] ?? hostname;
  const target = new URL(parsed.href);
  target.hostname = pinned.includes(':') ? `[${pinned}]` : pinned;
  return {
    url: target.href,
    host: parsed.host,
    ...(parsed.protocol === 'https:' ? { serverName: hostname } : {}),
  };
}
