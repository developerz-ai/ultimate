// What a URL that carries a credential may say about itself, and what it must hand the run's
// secret set. A proxy URL holds its password in the userinfo; a provider's CDP connect URL holds
// its access token in the query or the path. Both are named in errors and both pass through text
// this package persists, so the split is made once, here.

/**
 * Scheme and host — `wss://connect.provider.test:443` — and nothing a credential can live in: no
 * userinfo, no path, no query. A string that is not a URL answers a fixed phrase rather than
 * itself, because the caller is about to print the answer.
 */
export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return 'an endpoint that is not a URL';
  }
}

/** A lone `%` survives `URL` parsing and makes `decodeURIComponent` throw; the raw text is the answer then. */
const decoded = (part: string): string => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** True when the userinfo carries anything — the half `--proxy-server` cannot be handed. */
export function hasCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/** `http://user:pass@exit:8080` → `http://exit:8080` plus the pair, decoded as the proxy expects. */
export function splitCredentials(url: string): {
  readonly bare: string;
  readonly username: string;
  readonly password: string;
} {
  const parsed = new URL(url);
  const username = decoded(parsed.username);
  const password = decoded(parsed.password);
  parsed.username = '';
  parsed.password = '';
  // `URL` renders a trailing slash for an empty path; a proxy argument never had one.
  return { bare: parsed.toString().replace(/\/$/, ''), username, password };
}

/**
 * Every value in the URL that is, or may be, a credential — for the run's redaction set.
 *
 * The whole URL first, then the parts that can be quoted on their own: a launcher's error says
 * `401 for /devtools/browser/<id>?token=…` as readily as it repeats the URL. The path counts
 * because a browser id in a CDP path IS the capability. Encoded and decoded forms both, since a
 * message may carry either. The host is left out on purpose: it is what an error is allowed to say.
 */
export function urlSecretValues(url: string): readonly string[] {
  const values = new Set<string>([url]);
  try {
    const parsed = new URL(url);
    // The password and not the username: a proxy username is an account and a zone, and redacting
    // `admin` by value would blank the word out of every page artifact.
    values.add(parsed.password);
    values.add(decoded(parsed.password));
    if (parsed.pathname !== '/') values.add(`${parsed.pathname}${parsed.search}`);
    if (parsed.search !== '') values.add(parsed.search.slice(1));
    for (const value of parsed.searchParams.values()) values.add(value);
  } catch {
    // Not a URL: the whole string above is all there is to redact.
  }
  values.delete('');
  return [...values];
}
