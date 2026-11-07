// Single responsibility: base64url, both directions, with NO imports — so the server half
// (`tokens.ts` re-exports it) and the browser entry (`client.ts`) share one implementation and the
// client bundle pays for nothing else. WebAuthn speaks base64url on every field of its JSON wire.

const BASE64URL_UNSAFE = /[+/=]/g;
const BASE64URL_REPLACEMENTS: Readonly<Record<string, string>> = { '+': '-', '/': '_', '=': '' };

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(BASE64URL_UNSAFE, (char) => BASE64URL_REPLACEMENTS[char] ?? '');
}

/**
 * The inverse of `base64Url`, for the segments of a JWT. Answers `null` rather than throwing
 * because every caller is reading an attacker-supplied string — a `URIError` or an `InvalidCharacterError`
 * escaping from here would turn a coded refusal into a 500, the same reason `readCookie` never throws.
 */
export function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> | null {
  const padded = segment
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * `base64UrlBytes`, refusing every spelling but the canonical one: `atob` forgives padding,
 * whitespace and the standard alphabet, so two strings would name one credential id. A WebAuthn
 * field is compared as text in places (the challenge in `clientDataJSON`), so it has ONE spelling.
 */
export function canonicalBase64UrlBytes(segment: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const bytes = base64UrlBytes(segment);
  return bytes !== null && base64Url(bytes) === segment ? bytes : null;
}
