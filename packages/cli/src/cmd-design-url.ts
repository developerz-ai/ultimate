// Which URLs `x design research` may reach: the typed reference, every link `--follow` visits, and —
// through the CDP driver's interception — every navigation, redirect and subresource the page asks
// for. One policy for all of them: public hosts only. The screen is core's (`hostDecision`'s address
// floor, `screenDial`'s resolve-and-classify), the one `@ultimat3/scraping`'s browser leg uses too.

import type { HostRule } from '@ultimat3/core';
import { ANY_HOST, classifyAddress, hostDecision, hostMatches } from '@ultimat3/core';
import type { DialResolve } from '@ultimat3/core/outbound';
import { resolveDialHost, screenDial } from '@ultimat3/core/outbound';
import { DEFAULT_PAGE_TIMEOUT_MS } from './cdp-shot-clock';
import type { DialRefusal } from './cdp-shot-driver-screen';
import { DesignReferenceUnreachableError, DesignUrlRefusedError } from './cmd-design-errors';
import { designSlug } from './cmd-design-paths';
import { BadFlagError } from './errors';

export interface DesignHostPolicy {
  /** `*` plus any harness-trusted host: core's floor keeps the wildcard off every inward literal. */
  readonly allowHosts: readonly HostRule[];
  /** Exact hosts admitted without a resolve — a TEST HARNESS seam, never a flag. */
  readonly trustedHosts: readonly string[];
  readonly resolve: DialResolve;
}

/**
 * `trustedHosts` exists so a fixture server on 127.0.0.1 can be researched in a test: injected by
 * the harness through the run's options, and deliberately absent from the command's flags — a
 * flag that admitted loopback would be the SSRF this policy exists to refuse.
 */
export function designHostPolicy(input: {
  readonly resolve?: DialResolve | undefined;
  readonly trustedHosts?: readonly string[] | undefined;
}): DesignHostPolicy {
  const trustedHosts = input.trustedHosts ?? [];
  return {
    allowHosts: [ANY_HOST, ...trustedHosts],
    trustedHosts,
    resolve: input.resolve ?? resolveDialHost,
  };
}

/** The reference as typed: http(s), no credentials. Anything else is refused by name. */
export function readReferenceUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DesignUrlRefusedError({ url: raw, reason: 'is not an absolute URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DesignUrlRefusedError({ url: raw, reason: `is ${parsed.protocol}, not http(s)` });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new DesignUrlRefusedError({
      url: raw,
      reason: 'carries credentials, which would ride every request the page makes',
    });
  }
  return raw;
}

const hostnameOf = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

const isTrusted = (hostname: string, policy: DesignHostPolicy): boolean =>
  policy.trustedHosts.some((rule) => hostMatches(hostname, rule));

/**
 * The typed URL, screened before a browser exists: the address floor, then — for a name — every
 * address it resolves to. A name that does not resolve is unreachable, not refused: nothing about
 * it is inside the network, it is simply not there.
 */
export async function screenReference(url: string, policy: DesignHostPolicy): Promise<void> {
  if (!hostDecision(url, policy.allowHosts).allowed) {
    throw new DesignUrlRefusedError({
      url,
      reason: 'names a loopback, private or link-local address',
    });
  }
  const parsed = new URL(url);
  const hostname = hostnameOf(parsed);
  if (classifyAddress(hostname) !== undefined || isTrusted(hostname, policy)) return;
  const verdict = await screenDial(parsed, { resolve: policy.resolve });
  if ('pin' in verdict) return;
  if ('unresolved' in verdict) {
    throw new DesignReferenceUnreachableError({
      url,
      reason: verdict.unresolved,
      timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
    });
  }
  // The class, never the address: core's own rule for a refusal reason.
  throw new DesignUrlRefusedError({ url, reason: `resolves to a ${verdict.refused} address` });
}

/** The schemes the browser dials by name. */
const DIALLED = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * The driver's `dialScreen.screen`: `undefined` when the floor decides alone (a literal, a hostless
 * scheme, a trusted host), else the refusal or `undefined` to release. A DEFINITE answer — every
 * address public, or one not — is memoised per name for the session: a page asks for the same CDN a
 * hundred times. A resolver failure or an empty answer is `unresolved` and asked again next time:
 * a transient SERVFAIL proves nothing about where the name points, so it is never cached, and
 * never reported as private.
 */
export function browserDialScreen(
  policy: DesignHostPolicy,
): (url: string) => Promise<DialRefusal | undefined> | undefined {
  const known = new Map<string, DialRefusal | 'public'>();
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (!DIALLED.has(parsed.protocol)) return undefined;
    const hostname = hostnameOf(parsed);
    if (hostname === '' || classifyAddress(hostname) !== undefined) return undefined;
    if (isTrusted(hostname, policy)) return undefined;
    const held = known.get(hostname);
    if (held !== undefined) return Promise.resolve(held === 'public' ? undefined : held);
    return screenDial(parsed, { resolve: policy.resolve }).then(
      (verdict): DialRefusal | undefined => {
        if ('unresolved' in verdict) return 'unresolved';
        known.set(hostname, 'pin' in verdict ? 'public' : 'private');
        return 'pin' in verdict ? undefined : 'private';
      },
      (): DialRefusal => 'unresolved',
    );
  };
}

/**
 * `--allow-hosts`: the hosts `--follow` may visit beyond the reference's own origin. A public name
 * or a `*.` suffix; never `*`, `localhost` or an inward literal — the flag widens what is FOLLOWED,
 * and it can never widen what the browser may reach.
 */
export function readDesignAllowHosts(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw.split(',').map((entry) => {
    const host = entry.trim().toLowerCase();
    if (host === '' || host === ANY_HOST) {
      throw new BadFlagError({
        flag: 'allow-hosts',
        command: 'design research',
        reason: host === '' ? 'lists an empty host' : '* would follow every link on the web',
        fix: 'x design research https://example.com/ --follow 5 --allow-hosts docs.example.com',
      });
    }
    const literal = classifyAddress(host);
    const name = host.replace(/\.$/, '');
    if (
      (literal !== undefined && literal !== 'public') ||
      name === 'localhost' ||
      name.endsWith('.localhost')
    ) {
      throw new DesignUrlRefusedError({
        url: host,
        reason: 'names a loopback, private or link-local host',
      });
    }
    return host;
  });
}

/**
 * The links `--follow <n>` visits: same origin as the reference, or a host `--allow-hosts` names;
 * http(s) only, the fragment dropped, a page whose slug is already taken skipped, in page order,
 * at most `n`. Each is screened again before it is visited, exactly like the reference.
 */
export function followTargets(
  reference: string,
  links: readonly string[],
  allowHosts: readonly string[],
  n: number,
): readonly string[] {
  const origin = new URL(reference);
  // Deduped on the DIRECTORY a page is written to, not its href: `/docs/`, `/docs?tab=2` and the
  // reference's own `/docs` share one slug, and a followed page must never overwrite another's.
  const seen = new Set([designSlug(reference)]);
  const out: string[] = [];
  for (const link of links) {
    if (out.length >= n) break;
    let parsed: URL;
    try {
      parsed = new URL(link);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    parsed.hash = '';
    const allowed =
      parsed.origin === origin.origin ||
      allowHosts.some((rule) => hostMatches(parsed.hostname, rule));
    const slug = designSlug(parsed.href);
    if (!allowed || seen.has(slug)) continue;
    seen.add(slug);
    out.push(parsed.href);
  }
  return out;
}
