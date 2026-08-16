// Single responsibility: verifying a JWT's signature against a provider's published JWKS.
// `crypto.subtle` covers RS256 and ES256, so this costs no dependency. It exists because the OIDC
// Core 3.1.3.7 exemption — "a token fetched over TLS straight from the token endpoint needs no
// signature check" — holds for exactly one channel, and IdP-initiated login, `response_mode=
// form_post`, back-channel logout and token exchange are all not it. On any of those, an
// unverified JWT with the right `iss`, `aud` and a victim's `sub` is a full account takeover with
// no credential, so a signature check has to exist before those doors are opened.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { oauthExchangeFailed, oauthTokenInvalid } from './errors';
import type { OAuthProvider } from './oauth';
import type { OAuthFetch } from './oauth-exchange';
import { base64UrlBytes } from './tokens';

/**
 * The two asymmetric algorithms every OP in practice signs with. `HS256` is deliberately absent
 * and so is `none`: a symmetric algorithm verified against a *public* key set is the classic
 * algorithm-confusion forgery, and refusing the header value is how it stays unreachable.
 */
export type JwtAlgorithm = 'RS256' | 'ES256';

const SUPPORTED_ALGORITHMS: readonly string[] = ['RS256', 'ES256'];

export interface JwtHeader {
  readonly alg: JwtAlgorithm;
  readonly kid: string | null;
}

/** What a signature check needs: one key, for one `kid`, for one algorithm. */
export interface JwksKeySource {
  keyFor(kid: string | null, alg: JwtAlgorithm): Promise<CryptoKey>;
}

/**
 * How a caller declares where its trust comes from. `'token-endpoint-tls'` is the OIDC exemption,
 * spelled out rather than defaulted: a call site that never names its channel is a call site that
 * silently inherited "unverified" when somebody added a second way in.
 */
export type IdTokenKeys = 'token-endpoint-tls' | JwksKeySource;

/** Short enough that a rotated key set is picked up on its own; a new `kid` refreshes early. */
export const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000;

const DEFAULT_TIMEOUT_MS = 10_000;

export interface JwksClientOptions {
  /** Named in every refusal this client throws. */
  readonly provider: string;
  readonly jwksUri: string;
  /** Injected in tests; production uses the global. */
  readonly fetch?: OAuthFetch | undefined;
  /** No `Date.now()` in this package: the cache's age is measured against this. */
  readonly clock?: Clock | undefined;
  readonly ttlMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const importParams = (alg: JwtAlgorithm): RsaHashedImportParams | EcKeyImportParams =>
  alg === 'RS256'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };

const verifyParams = (alg: JwtAlgorithm): AlgorithmIdentifier | EcdsaParams =>
  alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };

/** A JWT header is attacker-supplied, so an unreadable one is `null` and never an exception. */
export function decodeJwtHeader(segment: string): JwtHeader | null {
  const bytes = base64UrlBytes(segment);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const alg = parsed['alg'];
  if (typeof alg !== 'string' || !SUPPORTED_ALGORITHMS.includes(alg)) return null;
  const kid = parsed['kid'];
  return { alg: alg as JwtAlgorithm, kid: typeof kid === 'string' && kid !== '' ? kid : null };
}

/** A key set entry the import understood. `kty` decides which algorithm it can ever verify. */
const algorithmOf = (jwk: Record<string, unknown>): JwtAlgorithm | null => {
  const alg = jwk['alg'];
  if (alg === 'RS256' || alg === 'ES256') return alg;
  if (jwk['kty'] === 'RSA') return 'RS256';
  if (jwk['kty'] === 'EC' && jwk['crv'] === 'P-256') return 'ES256';
  return null;
};

/**
 * Caches by `kid` with a TTL, and refetches once when a token names a `kid` the cache has never
 * seen — which is what makes a key rotation heal itself instead of failing every login until the
 * TTL runs out. One refetch, not one per token: an unknown `kid` an attacker invents must not
 * become an unbounded outbound request per attempt, so the refresh is rate-limited by the same
 * TTL as the ordinary one.
 */
export function createJwksClient(options: JwksClientOptions): JwksKeySource {
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  let keys = new Map<string, CryptoKey>();
  let fetchedAtMs = Number.NEGATIVE_INFINITY;
  let inflight: Promise<Map<string, CryptoKey>> | null = null;

  const fetchKeys = async (): Promise<Map<string, CryptoKey>> => {
    const doFetch: OAuthFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    let response: Response;
    try {
      response = await doFetch(options.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (error) {
      throw oauthExchangeFailed({
        provider: options.provider,
        stage: 'jwks',
        detail:
          error instanceof Error ? error.message : 'the request failed before a response arrived',
        fix: `curl -sS -m 5 ${options.jwksUri}`,
      });
    }
    if (!response.ok) {
      throw oauthExchangeFailed({
        provider: options.provider,
        stage: 'jwks',
        detail: 'the key set could not be read, so no signature can be checked',
        status: response.status,
        fix: `curl -sS -m 5 ${options.jwksUri}`,
      });
    }
    const body: unknown = await response.json().catch(() => undefined);
    const entries = isRecord(body) && Array.isArray(body['keys']) ? body['keys'] : [];
    const next = new Map<string, CryptoKey>();
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const alg = algorithmOf(entry);
      const kid = entry['kid'];
      if (alg === null || typeof kid !== 'string' || kid === '') continue;
      // A key the runtime cannot import is skipped rather than fatal: one malformed entry in a
      // published set must not take down every login the other keys would still have verified.
      const key = await crypto.subtle
        .importKey('jwk', entry as JsonWebKey, importParams(alg), false, ['verify'])
        .catch(() => null);
      if (key !== null) next.set(`${kid}:${alg}`, key);
    }
    keys = next;
    fetchedAtMs = clock.now().getTime();
    return next;
  };

  // One in-flight refresh shared by every concurrent caller: a cold cache under load is otherwise
  // one outbound request per request in flight, against the IdP, at exactly the worst moment.
  const load = async (): Promise<Map<string, CryptoKey>> => {
    inflight ??= fetchKeys().finally(() => {
      inflight = null;
    });
    return await inflight;
  };

  const lookup = (current: Map<string, CryptoKey>, kid: string | null, alg: JwtAlgorithm) => {
    if (kid !== null) return current.get(`${kid}:${alg}`) ?? null;
    // No `kid`: unambiguous only when the set holds exactly one key for this algorithm.
    const matches = [...current.entries()].filter(([id]) => id.endsWith(`:${alg}`));
    return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
  };

  return {
    async keyFor(kid, alg) {
      const staleAtMs = fetchedAtMs + ttlMs;
      let current = keys;
      const known = lookup(current, kid, alg) !== null;
      if (!known || clock.now().getTime() >= staleAtMs) current = await load();
      const key = lookup(current, kid, alg);
      if (key === null) {
        throw oauthTokenInvalid(
          options.provider,
          `no ${alg} key in the published set matches this token's kid`,
          `curl -sS -m 5 ${options.jwksUri}   # then confirm the token was signed by this issuer`,
        );
      }
      return key;
    },
  };
}

const clients = new Map<string, JwksKeySource>();

/**
 * The provider's own key set, built once per provider id. Memoised because the cache is the point:
 * a client rebuilt per request refetches the key set per request.
 */
export function providerJwks(
  provider: OAuthProvider,
  options?: Omit<JwksClientOptions, 'provider' | 'jwksUri'>,
): JwksKeySource {
  if (provider.jwksUri === null) {
    throw oauthTokenInvalid(
      provider.id,
      'this provider publishes no jwks_uri, so an id token from it can only be trusted on the token endpoint',
      `register ${provider.id} with an explicit jwksUri, or read its id token only through exchangeOAuthCode()`,
    );
  }
  const existing = clients.get(provider.id);
  if (existing !== undefined) return existing;
  const client = createJwksClient({ ...options, provider: provider.id, jwksUri: provider.jwksUri });
  clients.set(provider.id, client);
  return client;
}

/**
 * `false` for every way a token can fail to be this key set's: a malformed header, an algorithm
 * that is not one of the two asymmetric ones, an unreadable signature, a signature that does not
 * verify. A missing key throws — that is a configuration answer, not a verdict on the token.
 */
export async function verifyJwtSignature(token: string, keys: JwksKeySource): Promise<boolean> {
  const segments = token.split('.');
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  if (
    segments.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined
  ) {
    return false;
  }
  const header = decodeJwtHeader(headerSegment);
  if (header === null) return false;
  const signature = base64UrlBytes(signatureSegment);
  if (signature === null || signature.length === 0) return false;
  const key = await keys.keyFor(header.kid, header.alg);
  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  return await crypto.subtle.verify(verifyParams(header.alg), key, signature, signed);
}
