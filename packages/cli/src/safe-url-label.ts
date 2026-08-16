// Single responsibility: a connection URL rendered so it can be printed, logged and scraped —
// scheme, host, path, and never the userinfo, query or fragment that carry the password.
// DATABASE_URL, NATS_URL and S3_ENDPOINT all reach `x dev --json` as raw strings, so the redaction
// has one implementation rather than one per caller that remembers.

/**
 * `fallback` is the caller's, not this file's: a string that does not parse as a URL is a fact
 * about that binding, and only the caller knows which binding it was. Never the raw string — an
 * unparseable value is exactly where a hand-written credential ends up.
 */
export function safeUrlLabel(url: string, fallback: string): string {
  let label: string;
  try {
    const parsed = new URL(url);
    label = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return fallback;
  }
  // A scheme with no `//` is parsed as ONE opaque path — `app:user:pw@host/db` keeps its whole
  // credential in `pathname` and `username` is empty, so dropping the userinfo fields is not
  // enough. Any surviving `@` is treated as userinfo we failed to split, and the fallback wins: a
  // host printed with a `@` in it is a redaction that did not happen.
  return label.includes('@') ? fallback : label;
}
