// Single responsibility: the one way this package's tests mint an id token. Three OAuth test
// files each needs a base64url-encoded JWT, and three private copies of the encoder is three
// chances for one to drift from what `decodeIdToken` actually parses. Not part of the public
// API — `index.ts` deliberately does not re-export it.

import type { IdTokenClaims } from './id-token';
import { base64Url } from './tokens';

/** `base64Url` takes bytes because every real secret is bytes; a JWT segment is text. */
export const base64UrlText = (value: string): string => base64Url(new TextEncoder().encode(value));

/**
 * Header, payload, and a signature that is not one. Signatures are never checked here — the
 * token is only ever read straight off the token endpoint — so a fixture needs no signer.
 */
// The union, and not `Record<string, unknown>` alone: `IdTokenClaims` is an `interface`, so it has
// no implicit index signature and the one shape this fixture exists to serialise was the one shape
// it refused. The record arm stays for the malformed payloads `id-token.test.ts` builds by hand.
export const unsignedJwt = (claims: IdTokenClaims | Readonly<Record<string, unknown>>): string =>
  `${base64UrlText('{"alg":"RS256"}')}.${base64UrlText(JSON.stringify(claims))}.signature`;
