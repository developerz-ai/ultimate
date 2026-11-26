// Single responsibility: the response headers a caller asks `outbound()` to keep on a refusal
// (`refusal: { headers }`), checked once at the call and read off the answer as `meta.headers`.
// A refusal never keeps a credential-named header, and no value is kept whole.

import { UltimateError } from './errors';
import { isRedactedKey } from './logger';
import type { OutboundSite } from './outbound-errors';
import { siteLabel } from './outbound-errors';
import { redactedValue } from './redact-values';

/** The most names one call may ask for: a request id and a few more, never the whole answer. */
export const REFUSAL_HEADERS_MAX = 16;
/** The longest header name, and how much of a value is kept. */
const NAME_CHARS = 64;
export const REFUSAL_HEADER_VALUE_CHARS = 200;

/** An RFC 9110 field name: a token. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Credential carriers `isRedactedKey` does not name: a challenge repeats a realm and a nonce, and
 * the second cookie header is a cookie all the same.
 */
const NEVER = new Set(['www-authenticate', 'proxy-authenticate', 'set-cookie2']);

const invalid = (site: OutboundSite, why: string, fix: string): never => {
  throw new UltimateError({
    code: 'X_INVARIANT',
    cause: `${siteLabel(site)} was given refusal.headers that ${why}`,
    fix,
    meta: { vendor: site.vendor },
  });
};

/**
 * The names to keep, lowercased and deduplicated. `undefined` when the call asked for none.
 * Refused at the call, before a byte is sent: a request id that was never captured cannot be
 * asked for again after the vendor's error.
 */
export function refusalHeaderNames(
  names: unknown,
  site: OutboundSite,
): readonly string[] | undefined {
  if (names === undefined) return undefined;
  if (!Array.isArray(names))
    return invalid(
      site,
      `is not an array of header names (${typeof names})`,
      "refusal: { headers: ['x-request-id'] }",
    );
  if (names.length > REFUSAL_HEADERS_MAX)
    return invalid(
      site,
      `names ${String(names.length)} headers, more than the ${String(REFUSAL_HEADERS_MAX)} a refusal keeps`,
      "refusal: { headers: ['x-request-id'] }",
    );
  const kept = new Set<string>();
  for (const name of names as readonly unknown[]) {
    if (typeof name !== 'string' || !TOKEN.test(name))
      return invalid(
        site,
        'holds an entry that is not a header name',
        "refusal: { headers: ['x-request-id'] }",
      );
    if (name.length > NAME_CHARS)
      return invalid(
        site,
        `holds a header name longer than ${String(NAME_CHARS)} characters`,
        "refusal: { headers: ['x-request-id'] }",
      );
    const lower = name.toLowerCase();
    if (isRedactedKey(lower) || NEVER.has(lower))
      return invalid(
        site,
        `asks for '${lower}', a credential-carrying header, and a refusal never keeps one`,
        "refusal: { headers: ['x-request-id'] }",
      );
    kept.add(lower);
  }
  return [...kept];
}

/** The asked-for headers the answer carries, lowercased by name, each value redacted and capped. */
export function refusalHeadersOf(
  names: readonly string[],
  received: Headers,
): Record<string, string> {
  const entries: [string, string][] = [];
  for (const name of names) {
    const value = received.get(name);
    if (value !== null)
      entries.push([name, redactedValue(value).slice(0, REFUSAL_HEADER_VALUE_CHARS)]);
  }
  return Object.fromEntries(entries);
}
