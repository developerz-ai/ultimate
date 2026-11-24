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
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

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
      "outbound({ …, refusal: { headers: ['x-request-id'] } })   # an array of header names",
    );
  if (names.length > REFUSAL_HEADERS_MAX)
    return invalid(
      site,
      `names ${String(names.length)} headers, more than the ${String(REFUSAL_HEADERS_MAX)} a refusal keeps`,
      "outbound({ …, refusal: { headers: ['x-request-id'] } })   # list only what a person needs from the vendor's error, such as its request id",
    );
  const kept = new Set<string>();
  for (const name of names as readonly unknown[]) {
    const lower = typeof name === 'string' ? name.toLowerCase() : '';
    if (lower === '' || lower.length > NAME_CHARS || !TOKEN.test(lower))
      return invalid(
        site,
        'holds an entry that is not a header name',
        "outbound({ …, refusal: { headers: ['x-request-id'] } })   # each entry a header name, as the vendor sends it",
      );
    if (isRedactedKey(lower) || NEVER.has(lower))
      return invalid(
        site,
        `asks for '${lower}', a credential-carrying header, and a refusal never keeps one`,
        `outbound({ …, refusal: { headers: ['x-request-id'] } })   # without '${lower}': a refusal never keeps a credential-carrying header`,
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
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = received.get(name);
    if (value !== null) out[name] = redactedValue(value).slice(0, REFUSAL_HEADER_VALUE_CHARS);
  }
  return out;
}
