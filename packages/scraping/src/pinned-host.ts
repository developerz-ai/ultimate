// The DNS half of `allowHosts`, for the two legs this package dials itself — the HTTP leg and the
// robots read. Core's `hostDecision` is synchronous and judges NAMES: a wildcard never admits an
// address literal inside the network, but `allowHosts: ['*']` still admits a hostname that
// resolves inward. So a name admitted by a wildcard alone is resolved here, every address
// classified and the connection PINNED to the approved address by core's `screenDial` — the one
// screen `@ultimat3/jobs`' `webhook-target.ts` and `outbound()` call too. This keeps its own code.

import type { HostRule } from '@ultimat3/core';
import { classifyAddress, hostMatches } from '@ultimat3/core';
import type { DialResolve } from '@ultimat3/core/outbound';
import { screenDial } from '@ultimat3/core/outbound';
import { hostResolvesInward } from './error-throws-session';

/** Every address a hostname answers. Injected in tests: the network is sealed in this repo. */
export type HostResolve = DialResolve;

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
  const verdict = await screenDial(parsed, { resolve });
  if ('pin' in verdict) return verdict.pin;
  // A resolver failure propagates as itself: nothing unscreened is dialled, and the same name
  // would not have resolved for `fetch` either. No address at all is refused, as before.
  if ('unresolved' in verdict && verdict.error !== undefined) throw verdict.error;
  throw hostResolvesInward(url, hostname, 'refused' in verdict ? verdict.refused : 'unresolvable');
}
