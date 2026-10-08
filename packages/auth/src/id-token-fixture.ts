// Single responsibility: the one way this package's tests mint an id token. Three OAuth test
// files each needs a base64url-encoded JWT, and three private copies of the encoder is three
// chances for one to drift from what `decodeIdToken` actually parses. Not part of the public
// API — `index.ts` deliberately does not re-export it.

import type { IdTokenClaims } from './id-token';
import { base64Url } from './tokens';

/** `base64Url` takes bytes because every real secret is bytes; a JWT segment is text. */
export const base64UrlText = (value: string): string => base64Url(new TextEncoder().encode(value));

/**
 * Header, payload, and a signature that is not one. For a test that verifies nothing — a call
 * passing `keys: 'token-endpoint-tls'`, or a decode-only check. A test going through the default
 * exchange signs with `testSigner()` below, since that verifies against the provider's key set.
 */
// The union, and not `Record<string, unknown>` alone: `IdTokenClaims` is an `interface`, so it has
// no implicit index signature and the one shape this fixture exists to serialise was the one shape
// it refused. The record arm stays for the malformed payloads `id-token.test.ts` builds by hand.
export const unsignedJwt = (claims: IdTokenClaims | Readonly<Record<string, unknown>>): string =>
  `${base64UrlText('{"alg":"RS256"}')}.${base64UrlText(JSON.stringify(claims))}.signature`;

/** An ES256 key pair, its published key set, and the one way a test mints a SIGNED id token. */
export interface TestSigner {
  /** What the provider publishes at its `jwks_uri`: each JWK plus the `kid` the header names. */
  readonly jwks: { readonly keys: readonly (JsonWebKey & { readonly kid: string })[] };
  sign(claims: IdTokenClaims | Readonly<Record<string, unknown>>): Promise<string>;
}

/**
 * The default exchange verifies an id token against the provider's `jwks_uri`, so a test that
 * goes through it serves `signer.jwks` at that URL. ES256 because WebCrypto's ECDSA output is
 * already the JWS `r || s` encoding — no DER to unwrap.
 */
export async function testSigner(kid = 'test-key'): Promise<TestSigner> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const header = base64UrlText(JSON.stringify({ alg: 'ES256', kid }));
  return {
    jwks: { keys: [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }] },
    async sign(claims) {
      const signed = `${header}.${base64UrlText(JSON.stringify(claims))}`;
      const signature = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(signed),
      );
      return `${signed}.${base64Url(new Uint8Array(signature))}`;
    },
  };
}
