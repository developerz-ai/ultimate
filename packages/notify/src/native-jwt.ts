// Single responsibility: the two signed JWTs native push needs, over WebCrypto and nothing else —
// APNs' ES256 provider token (a `.p8` key) and Google's RS256 service-account assertion. The key
// arrives as a `Secret` and is revealed in exactly one place, the import below.

import type { Secret } from '@ultimat3/core';
import { revealSecret } from '@ultimat3/core';

export type JwtAlgorithm = 'ES256' | 'RS256';

/** A ternary over the closed pair, never a map read: `bun run proto-index` (`X_PROTO_CHAIN_INDEX`). */
const importParams = (algorithm: JwtAlgorithm): EcKeyImportParams | RsaHashedImportParams =>
  algorithm === 'ES256'
    ? { name: 'ECDSA', namedCurve: 'P-256' }
    : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

/** WebCrypto's ECDSA output is raw `r || s`, which is exactly JWS ES256's encoding — no DER. */
const signParams = (algorithm: JwtAlgorithm): AlgorithmIdentifier | EcdsaParams =>
  algorithm === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const PEM_BODY = /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/;

/**
 * The DER inside a PKCS#8 PEM, or `undefined`. A key pasted into an env var often arrives with its
 * newlines spelled `\n` (a JSON service-account file's `private_key`), so both spellings read.
 */
export function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> | undefined {
  const match = PEM_BODY.exec(pem.replaceAll('\\n', '\n'));
  if (match?.[1] === undefined) return undefined;
  const body = match[1].replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return undefined;
  return Uint8Array.from(Buffer.from(body, 'base64'));
}

/** Import a PKCS#8 key for signing, or `undefined` when it is no key of that algorithm. */
export async function importSigningKey(
  algorithm: JwtAlgorithm,
  key: Secret,
): Promise<CryptoKey | undefined> {
  const der = pkcs8Der(revealSecret(key));
  if (der === undefined) return undefined;
  try {
    return await crypto.subtle.importKey('pkcs8', der, importParams(algorithm), false, ['sign']);
  } catch {
    // The engine's message can quote key material; the caller names the variable instead.
    return undefined;
  }
}

/** `header.claims.signature`, each segment base64url JSON. */
export async function signJwt(
  algorithm: JwtAlgorithm,
  key: CryptoKey,
  header: Readonly<Record<string, string>>,
  claims: Readonly<Record<string, string | number>>,
): Promise<string> {
  const text = new TextEncoder();
  const segment = (value: object): string => base64Url(text.encode(JSON.stringify(value)));
  const unsigned = `${segment({ ...header, alg: algorithm })}.${segment(claims)}`;
  const signature = await crypto.subtle.sign(signParams(algorithm), key, text.encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}
