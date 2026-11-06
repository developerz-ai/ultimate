// Single responsibility: the two person-grant legs of `POST /oauth/token` — a code for tokens
// (RFC 6749 §4.1.3 + PKCE) and a refresh token for new ones (§6, OAuth 2.1 rotation). The rules:
// a code is single use and its replay revokes what it minted; a retired refresh token's replay
// revokes the whole grant; the redirect and the resource must be the ones the code was bound to.

import type { ResolvedAuthServerConfig } from './authorization-server-config';
import {
  firstRefresh,
  pkceMatches,
  refreshRecord,
  refused,
  type TokenOutcome,
  tokenAnswer,
} from './authorization-server-tokens';
import type { AuthServerClient } from './authorization-server-types';
import { sha256Hex } from './tokens';

type Form = ReadonlyMap<string, string>;

const invalidGrant = (description: string): TokenOutcome => refused('invalid_grant', description);

export async function exchangeCode(
  config: ResolvedAuthServerConfig,
  form: Form,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  const code = form.get('code');
  const verifier = form.get('code_verifier');
  if (code === undefined || verifier === undefined) {
    return refused('invalid_request', 'code and code_verifier are required');
  }
  const now = config.clock.now();
  const taken = await config.store.takeCode(sha256Hex(code), now);
  if (taken === null) return invalidGrant('the code is unknown');
  const record = taken.code;
  if (!taken.fresh) {
    // Somebody holds a copy of a code that was already redeemed: whatever it minted is suspect.
    await config.store.revokeGrant(record.grantId, now);
    config.emit({ kind: 'code-replayed', clientId: record.clientId });
    return invalidGrant('the code was already used; the grant it minted is revoked');
  }
  if (record.clientId !== client.clientId)
    return invalidGrant('the code was issued to another client');
  if (record.expiresAt.getTime() <= now.getTime()) return invalidGrant('the code expired');
  if (form.get('redirect_uri') !== record.redirectUri) {
    return invalidGrant('redirect_uri is not the one the code was issued for');
  }
  if (!pkceMatches(verifier, record.codeChallenge)) {
    return invalidGrant('the code_verifier does not match the code_challenge');
  }
  const resource = form.get('resource');
  if (resource !== undefined && resource !== record.resource) {
    return refused('invalid_target', 'the resource is not the one the grant is bound to');
  }
  const grant = await config.store.getGrant(record.grantId);
  if (grant === null || grant.revokedAt !== null) return invalidGrant('the grant is revoked');
  const refresh = await firstRefresh(config, grant.id);
  return tokenAnswer(config, grant, config.accessSeconds, refresh);
}

export async function exchangeRefresh(
  config: ResolvedAuthServerConfig,
  form: Form,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  const presented = form.get('refresh_token');
  if (presented === undefined) return refused('invalid_request', 'refresh_token is required');
  const now = config.clock.now();
  const hash = sha256Hex(presented);
  const token = await config.store.getToken(hash);
  if (token === null || token.kind !== 'refresh')
    return invalidGrant('the refresh token is unknown');
  if (token.retiredAt !== null) return replayed(config, token.grantId, client.clientId);
  const grant = await config.store.getGrant(token.grantId);
  if (grant === null || grant.revokedAt !== null) return invalidGrant('the grant is revoked');
  if (grant.clientId !== client.clientId)
    return invalidGrant('the token was issued to another client');
  if (grant.refreshedAt.getTime() + config.refreshIdleMs <= now.getTime()) {
    return invalidGrant('the grant sat idle past its refresh window');
  }
  const scope = form.get('scope');
  if (
    scope !== undefined &&
    scope.split(' ').sort().join(' ') !== [...grant.scopes].sort().join(' ')
  ) {
    // A narrower refresh would need per-token scopes; the honest answer is to say so.
    return refused(
      'invalid_scope',
      'a refresh keeps the granted scope; authorize again to change it',
    );
  }
  const resource = form.get('resource');
  if (resource !== undefined && resource !== grant.resource) {
    return refused('invalid_target', 'the resource is not the one the grant is bound to');
  }
  const next = refreshRecord(config, grant.id);
  const rotation = await config.store.rotateRefresh(hash, next.record, now);
  if (rotation.outcome === 'replayed') return replayed(config, rotation.grantId, client.clientId);
  if (rotation.outcome === 'unknown') return invalidGrant('the refresh token is unknown');
  await config.store.touchGrant(grant.id, now);
  return tokenAnswer(config, grant, config.accessSeconds, next.token);
}

/** A retired refresh token came back: one of two holders is a thief, so neither keeps the grant. */
async function replayed(
  config: ResolvedAuthServerConfig,
  grantId: string,
  clientId: string,
): Promise<TokenOutcome> {
  await config.store.revokeGrant(grantId, config.clock.now());
  config.emit({ kind: 'refresh-replayed', clientId });
  return invalidGrant('the refresh token was already rotated; the grant is revoked');
}
