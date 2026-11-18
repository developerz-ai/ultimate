// Single responsibility: decoding a JWT payload segment the caller presented. Answered three times
// over in this package until it moved here; "is this an object" — the question that gates every
// claim read after it — is core's `isJsonObject`, which refuses an array, so `[]` never narrows to a
// claims record.

import { isJsonObject } from '@ultimat3/core';
import { base64UrlBytes } from './tokens';

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
  return isJsonObject(parsed) ? parsed : null;
}
