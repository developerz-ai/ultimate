// Single responsibility: RFC 6749 §4.4 — a machine with no person to consent (a partner's nightly
// sync) trades its own secret for a short-lived access token. Confidential clients only, the
// subject is the client itself, scopes are its registered set narrowed by the request, and there
// is never a refresh token: the secret IS the long-lived credential, so a second one is a liability.

import type { ResolvedAuthServerConfig } from './authorization-server-config';
import { screenResource } from './authorization-server-request';
import { refused, type TokenOutcome, tokenAnswer } from './authorization-server-tokens';
import type { AuthServerClient } from './authorization-server-types';
import { randomToken } from './tokens';

export async function exchangeClientCredentials(
  config: ResolvedAuthServerConfig,
  form: ReadonlyMap<string, string>,
  client: AuthServerClient,
): Promise<TokenOutcome> {
  // The wire already proved the secret; a PUBLIC client has none to prove, so it never gets here.
  if (client.secretHash === null) {
    return refused('unauthorized_client', 'client_credentials needs a confidential client', 401);
  }
  if (!client.grantTypes.includes('client_credentials')) {
    return refused('unauthorized_client', 'this client may not use client_credentials');
  }
  // An empty registration is the server's whole set, as `AuthServerClient.scopes` documents.
  const registered =
    client.scopes.length === 0
      ? [...config.scopes]
      : client.scopes.filter((scope) => config.scopes.has(scope));
  const requested = form.get('scope');
  const scopes =
    requested === undefined || requested.trim() === ''
      ? registered
      : [...new Set(requested.split(' ').filter((scope) => scope !== ''))];
  if (scopes.length === 0 || !scopes.every((scope) => registered.includes(scope))) {
    return refused('invalid_scope', 'a requested scope is not one this client was registered for');
  }
  const resource = screenResource(config, form.get('resource'));
  if (resource === false) {
    return refused('invalid_target', 'the resource is not one this server issues tokens for');
  }
  const now = config.clock.now();
  const grant = {
    id: `g_${randomToken(16)}`,
    clientId: client.clientId,
    subject: client.clientId,
    scopes,
    resource,
    createdAt: now,
    refreshedAt: now,
    revokedAt: null,
  };
  await config.store.putGrant(grant);
  // `clientSeconds` is non-null whenever this grant is enabled: the config refuses otherwise.
  return tokenAnswer(config, grant, config.clientSeconds ?? config.accessSeconds, null);
}
