// `allowHosts`, as a decision every driver asks before a request leaves — never a note in a
// README. A headless browser inside your network is the widest SSRF surface an app can own: one
// injected `<img src="http://169.254.169.254/…">` on a page you do not control is a credential
// read, and no amount of "we only visit example.com" in prose intercepts it.

export type HostRule = string;

/** The one spelling that means "every host", written out so it is visible in review. */
export const ANY_HOST: HostRule = '*';

/**
 * Schemes with no host to match. `about:blank` is where every browser starts, `data:` and `blob:`
 * never leave the process — refusing them would refuse the first page load of every run.
 */
const HOSTLESS_SCHEMES = new Set(['about:', 'data:', 'blob:', 'javascript:']);

export interface HostDecision {
  readonly allowed: boolean;
  /** The host the URL resolved to, `''` for a hostless scheme. */
  readonly host: string;
}

/**
 * `example.com` matches that host EXACTLY. `*.example.com` matches any subdomain and NOT the
 * apex — the two are written separately on purpose: an allow list that silently included every
 * subdomain would let a `cdn-user-content.example.com` (whose contents somebody else controls)
 * through a rule an author wrote for the apex.
 */
export function hostMatches(host: string, rule: HostRule): boolean {
  if (rule === ANY_HOST) return true;
  const normalised = host.toLowerCase();
  const cleaned = rule.trim().toLowerCase();
  if (cleaned.startsWith('*.')) {
    const suffix = cleaned.slice(1);
    return normalised.endsWith(suffix) && normalised.length > suffix.length;
  }
  return normalised === cleaned;
}

/**
 * Fails CLOSED: a URL that cannot be parsed is refused. A driver handed a malformed request has
 * no way to know where it would have gone, and "we could not tell, so we let it through" is the
 * decision that makes the whole list advisory.
 */
export function hostDecision(url: string, allowHosts: readonly HostRule[]): HostDecision {
  const scheme = url.slice(0, Math.max(0, url.indexOf(':') + 1)).toLowerCase();
  if (HOSTLESS_SCHEMES.has(scheme)) return { allowed: true, host: '' };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { allowed: false, host: '' };
  }
  if (host === '') return { allowed: false, host };
  return { allowed: allowHosts.some((rule) => hostMatches(host, rule)), host };
}
