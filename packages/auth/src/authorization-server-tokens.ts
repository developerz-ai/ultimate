// Single responsibility: mint, answer and resolve the server's tokens. Opaque and stored hashed —
// never a JWT — so a revocation holds on the very next lookup, and a database read leaks no
// usable credential. PKCE's S256 check lives here too, compared in constant time.

import { timingSafeEqual } from '@ultimat3/core';
import type { ResolvedAuthServerConfig } from './authorization-server-config';
import type {
  AuthGrantRecord,
  AuthServerClient,
  AuthTokenRecord,
  ResolvedGrant,
} from './authorization-server-types';
import { base64Url, randomToken, sha256Hex } from './tokens';

/** Prefixes a secret scanner can match. Carry nothing; the token is 32 random bytes after them. */
export const ACCESS_TOKEN_PREFIX = 'xat_';
export const REFRESH_TOKEN_PREFIX = 'xrt_';

export type TokenOutcome =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      /** RFC 6749 §5.2 (or RFC 8628 §3.5) error. */
      readonly error: string;
      readonly description: string;
      /** 400 unless the client failed to authenticate (401). */
      readonly status: 400 | 401;
    };

export const refused = (
  error: string,
  description: string,
  status: 400 | 401 = 400,
): TokenOutcome => ({
  ok: false,
  error,
  description,
  status,
});

/** RFC 7636 §4.6: `BASE64URL(SHA256(ASCII(code_verifier))) == code_challenge`. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = new Bun.CryptoHasher('sha256').update(verifier).digest();
  return timingSafeEqual(base64Url(new Uint8Array(digest)), challenge);
}

const tokenRecord = (
  config: ResolvedAuthServerConfig,
  kind: AuthTokenRecord['kind'],
  grantId: string,
  lifeMs: number,
): { readonly token: string; readonly record: AuthTokenRecord } => {
  const token = `${kind === 'access' ? ACCESS_TOKEN_PREFIX : REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  const now = config.clock.now();
  return {
    token,
    record: {
      tokenHash: sha256Hex(token),
      kind,
      grantId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + lifeMs),
      retiredAt: null,
    },
  };
};

/** A refresh token's row: it lives as long as the idle window, which a rotation restarts. */
export const refreshRecord = (config: ResolvedAuthServerConfig, grantId: string) =>
  tokenRecord(config, 'refresh', grantId, config.refreshIdleMs);

/** An access token (stored), plus the refresh token when one was already minted for the answer. */
export async function tokenAnswer(
  config: ResolvedAuthServerConfig,
  grant: AuthGrantRecord,
  accessSeconds: number,
  refreshToken: string | null,
): Promise<TokenOutcome> {
  const access = tokenRecord(config, 'access', grant.id, accessSeconds * 1000);
  await config.store.putToken(access.record);
  return {
    ok: true,
    body: {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: accessSeconds,
      scope: grant.scopes.join(' '),
      ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
    },
  };
}

/**
 * A new refresh token, stored, for a grant that has none yet — only when the server enables the
 * grant AND the client is registered for it, the same rule `exchangeRefresh` holds it to.
 */
export async function firstRefresh(
  config: ResolvedAuthServerConfig,
  client: AuthServerClient,
  grantId: string,
): Promise<string | null> {
  if (!config.grants.has('refresh_token') || !client.grantTypes.includes('refresh_token')) {
    return null;
  }
  const refresh = refreshRecord(config, grantId);
  await config.store.putToken(refresh.record);
  return refresh.token;
}

/** A live access token's grant. `null` for unknown, expired, a refresh token, or revoked. */
export async function resolveAccess(
  config: ResolvedAuthServerConfig,
  token: string,
): Promise<{ readonly grant: AuthGrantRecord; readonly token: AuthTokenRecord } | null> {
  const record = await config.store.getToken(sha256Hex(token));
  if (record === null || record.kind !== 'access') return null;
  if (record.expiresAt.getTime() <= config.clock.now().getTime()) return null;
  const grant = await config.store.getGrant(record.grantId);
  if (grant === null || grant.revokedAt !== null) return null;
  return { grant, token: record };
}

export const resolvedGrant = (grant: AuthGrantRecord): ResolvedGrant => ({
  subject: grant.subject,
  scopes: new Set(grant.scopes),
  clientId: grant.clientId,
  resource: grant.resource,
});
