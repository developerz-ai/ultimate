// Single responsibility: the one way this package's tests mint an id token. Three OAuth test
// files each needs a base64url-encoded JWT, and three private copies of the encoder is three
// chances for one to drift from what `decodeIdToken` actually parses. Not part of the public
// API — `index.ts` deliberately does not re-export it.

import { base64Url } from './tokens';

/** `base64Url` takes bytes because every real secret is bytes; a JWT segment is text. */
export const base64UrlText = (value: string): string => base64Url(new TextEncoder().encode(value));

/**
 * Header, payload, and a signature that is not one. Signatures are never checked here — the
 * token is only ever read straight off the token endpoint — so a fixture needs no signer.
 */
export const unsignedJwt = (claims: Readonly<Record<string, unknown>>): string =>
  `${base64UrlText('{"alg":"RS256"}')}.${base64UrlText(JSON.stringify(claims))}.signature`;
