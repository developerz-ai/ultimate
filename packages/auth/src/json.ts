// Single responsibility: reading untrusted JSON — a provider's response body, or a JWT payload the
// caller presented. Both questions were answered six and three times over in this package, and on a
// JWT payload "is this an object" is what gates every claim read after it, so two copies quietly
// disagreeing about (say) an array would be two different answers to a security question.

import { base64UrlBytes } from './tokens';

/**
 * An ARRAY IS NOT A RECORD. That is the whole of the disagreement between the two variants of this
 * predicate in the wild, and it matters here: `JSON.parse('[1,2]')` is an object with numeric keys,
 * so without the array check a JWT payload of `[]` narrows to `Record<string, unknown>` and every
 * `parsed['iss']` below it reads `undefined` from a shape no issuer ever sends.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A base64url JWT segment as a JSON object, or `null` for every way it can fail to be one: not
 * base64url, not JSON, not an object. `null` rather than a throw because every caller is holding an
 * attacker-supplied string and each has its own coded refusal to raise — the same reason
 * `base64UrlBytes` and `readCookie` never throw.
 */
export function decodeJwtSegment(segment: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(segment);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}
