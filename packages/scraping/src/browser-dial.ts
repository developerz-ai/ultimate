// The DNS half of `allowHosts` for the BROWSER leg. The browser dials by itself, so nothing here can
// pin its socket the way `pinned-host.ts` pins the HTTP leg; what it can do is refuse to release a
// request whose wildcard-admitted name resolves inward (`10.x`, `169.254.169.254`) — the SSRF a
// name-only check let through. Chrome's own re-resolution (rebinding) stays open: `wiki/Known-Gaps.md`.

import type { HostRule } from '@ultimat3/core';
import { classifyAddress, hostMatches } from '@ultimat3/core';
import { screenDial } from '@ultimat3/core/outbound';
import type { HostResolve } from './pinned-host';

/** How the browser leg screens: the resolver, and whether a proxy resolves names instead. */
export interface BrowserDialScreen {
  readonly allowHosts: readonly HostRule[];
  readonly resolve: HostResolve;
  /** Through a proxy the EXIT resolves the name, so this box's answer says nothing — the HTTP leg's rule. */
  readonly proxied: boolean;
}

/** The schemes the browser opens a socket for by name. A WebSocket is a dial like any other. */
const DIALLED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const isWildcard = (rule: HostRule): boolean => {
  const cleaned = rule.trim();
  return cleaned === '*' || cleaned.startsWith('*.');
};

/**
 * `undefined` — synchronously — when there is nothing to resolve: a hostless or non-http scheme,
 * an address literal (core's floor already judged it), a host an EXACT rule names (the app said
 * that host in a line a reviewer can see), or a proxied session. Otherwise a promise of whether
 * the request must be REFUSED: one non-public address, or no answer at all, refuses — the browser
 * would not have reached an unresolvable name either, and failing closed is the only safe read.
 * Asked only of a URL `interceptVerdict` has already allowed.
 */
export function browserDialRefusal(
  url: string,
  screen: BrowserDialScreen,
): Promise<boolean> | undefined {
  if (screen.proxied) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!DIALLED_SCHEMES.has(parsed.protocol)) return undefined;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (hostname === '' || classifyAddress(hostname) !== undefined) return undefined;
  const exact = screen.allowHosts.some((rule) => !isWildcard(rule) && hostMatches(hostname, rule));
  if (exact) return undefined;
  return screenDial(parsed, { resolve: screen.resolve }).then(
    (verdict) => !('pin' in verdict),
    () => true,
  );
}
