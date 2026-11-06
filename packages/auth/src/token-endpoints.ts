// Single responsibility: RFC 7009 revocation and RFC 7662 introspection. Revocation answers 200
// whatever the token was (§2.2: an unknown token is not an error, or the endpoint is an oracle)
// and ends the whole grant at once. Introspection is a resource server's question, so it needs a
// confidential client and answers `{ active: false }`, nothing else, for a token it does not own.

import type { ResolvedAuthServerConfig } from './authorization-server-config';
import { refused, resolveAccess, type TokenOutcome } from './authorization-server-tokens';
import type { AuthServerClient } from './authorization-server-types';
import { sha256Hex } from './tokens';

const INACTIVE: TokenOutcome = { ok: true, body: { active: false } };

export async function revokeToken(
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  const token = form.get('token');
  if (token === undefined) return refused('invalid_request', 'token is required');
  const record = await config.store.getToken(sha256Hex(token));
  const grant = record === null ? null : await config.store.getGrant(record.grantId);
  // Only the client the token was issued to may revoke it (§2.1); anyone else learns nothing.
  if (grant !== null && grant.clientId === client.clientId) {
    await config.store.revokeGrant(grant.id, config.clock.now());
    config.emit({ kind: 'revoked', clientId: client.clientId });
  }
  return { ok: true, body: {} };
}

export async function introspectToken(
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  if (client.secretHash === null) {
    return refused('invalid_client', 'introspection needs a confidential client', 401);
  }
  const token = form.get('token');
  if (token === undefined) return refused('invalid_request', 'token is required');
  const live = await resolveAccess(config, token);
  if (live === null) return INACTIVE;
  const { grant } = live;
  const owned =
    grant.clientId === client.clientId ||
    (grant.resource !== null && client.resources.includes(grant.resource));
  if (!owned) return INACTIVE;
  return {
    ok: true,
    body: {
      active: true,
      scope: grant.scopes.join(' '),
      client_id: grant.clientId,
      sub: grant.subject,
      token_type: 'Bearer',
      iss: config.issuer,
      iat: Math.floor(live.token.createdAt.getTime() / 1000),
      exp: Math.floor(live.token.expiresAt.getTime() / 1000),
      ...(grant.resource === null ? {} : { aud: grant.resource }),
    },
  };
}
